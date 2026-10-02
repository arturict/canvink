import { useEffect, useLayoutEffect, useRef } from "react";
import type { StrokeElementV2 } from "../domain/v2";
import { isContextLost } from "./canvasSafety";
import { drawInkStroke } from "./ink";
import { framesOverlap, strokeBounds } from "./inkGeometry";
import { whenIdle } from "./InkLayers";
import { INK_RASTER_VERSION, inkRasterStore, type InkRasterRecord } from "./inkRasterStore";
import type { Rect } from "./operations/geometry";

/**
 * A per-page picture of the committed ink, so that opening a heavy page
 * shows its handwriting at once instead of after its Automerge document has
 * loaded (about a second for 7,000 strokes, one blocking task).
 *
 * While a page is open and idle, its ink as it looks when the page opens
 * (pan 0, zoom 1: the part in the editor's viewport) is drawn in idle slices
 * into a small canvas and stored in its own IndexedDB database. Opening the
 * page later shows that picture, placed where the ink will be, until the
 * real ink tiles have painted. Only ink is in the picture, in page order
 * (the highlighter multiplies with the ink below it); text, images and
 * printouts are not. A picture that is out of date (the page changed on
 * another device) is shown for as long as the page loads and then replaced.
 */

/** Longest side of a picture in pixels. */
export const INK_RASTER_MAX_SIDE = 1600;
/** Device pixel ratio a picture is drawn for at most. */
export const INK_RASTER_MAX_DPR = 2;
/** Quiet time after the last ink change before the picture is drawn. */
export const INK_RASTER_DEBOUNCE_MS = 1500;
/** Main-thread time one drawing slice takes at most. */
const RASTER_SLICE_MS = 10;

/** Where the editor shows the page when it opens, measured on screen. */
export interface InkRasterFrame {
  /** Screen position of the page's origin at pan 0 and zoom 1 (CSS pixels). */
  origin: { x: number; y: number };
  /** The editor's viewport on screen. */
  view: Rect;
  /** The page's paper within the viewport on screen, and its colour. */
  paper: Rect & { color: string };
  /** The part of the page in the viewport when it opens, in page units. */
  visible: Rect;
}

function intersect(left: Rect, right: Rect): Rect | null {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const width = Math.min(left.x + left.width, right.x + right.width) - x;
  const height = Math.min(left.y + left.height, right.y + right.height) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

/** A stroke's painted extent: its points grown by the pen width. */
function inkExtent(stroke: StrokeElementV2): Rect {
  const bounds = strokeBounds(stroke);
  const reach = stroke.size / 2 + 1;
  return {
    x: bounds.x - reach,
    y: bounds.y - reach,
    width: bounds.width + reach * 2,
    height: bounds.height + reach * 2,
  };
}

/**
 * The strokes that show in `visible` and the page area the picture covers:
 * their painted extent, cut to `visible` and snapped outwards to whole page
 * units. Null when no ink shows there.
 */
export function inkRasterRegion(
  strokes: readonly StrokeElementV2[],
  visible: Rect,
): { bounds: Rect; strokes: StrokeElementV2[] } | null {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  const shown: StrokeElementV2[] = [];
  for (const stroke of strokes) {
    if (stroke.points.length === 0) continue;
    const extent = inkExtent(stroke);
    if (!framesOverlap(extent, visible)) continue;
    shown.push(stroke);
    left = Math.min(left, extent.x);
    top = Math.min(top, extent.y);
    right = Math.max(right, extent.x + extent.width);
    bottom = Math.max(bottom, extent.y + extent.height);
  }
  if (shown.length === 0) return null;
  const cut = intersect({ x: left, y: top, width: right - left, height: bottom - top }, visible);
  if (!cut) return null;
  const x = Math.floor(cut.x);
  const y = Math.floor(cut.y);
  return {
    bounds: { x, y, width: Math.ceil(cut.x + cut.width) - x, height: Math.ceil(cut.y + cut.height) - y },
    strokes: shown,
  };
}

/**
 * Measures where the page shows when it opens: the viewport and surface
 * elements on screen now, moved from the current pan to the opening pan
 * (zoom 1 in both cases matters only for the origin, which a transform with
 * origin 0 0 does not scale). A page unit is a CSS pixel at zoom 1, so the
 * visible part of the page is the viewport less the origin.
 */
export function measureInkRasterFrame(input: {
  viewport: HTMLElement | null;
  surface: HTMLElement | null;
  current: { panX: number; panY: number };
  opening: { panX: number; panY: number };
  /** Size of a fixed sheet in page units; null for a free page, whose paper fills the viewport. */
  sheet: { width: number; height: number } | null;
  paperColor: string;
}): InkRasterFrame | null {
  const { viewport, surface } = input;
  if (!viewport || !surface) return null;
  const box = viewport.getBoundingClientRect();
  if (box.width < 1 || box.height < 1) return null;
  const surfaceBox = surface.getBoundingClientRect();
  const origin = {
    x: surfaceBox.left - input.current.panX + input.opening.panX,
    y: surfaceBox.top - input.current.panY + input.opening.panY,
  };
  const view = { x: box.left, y: box.top, width: box.width, height: box.height };
  const paper = input.sheet
    ? intersect({ x: origin.x, y: origin.y, width: input.sheet.width, height: input.sheet.height }, view)
    : view;
  return {
    origin,
    view,
    paper: { ...(paper ?? { x: view.x, y: view.y, width: 1, height: 1 }), color: input.paperColor },
    visible: { x: view.x - origin.x, y: view.y - origin.y, width: view.width, height: view.height },
  };
}

/** Pixels per page unit: the screen's density, capped, and the long side capped. */
export function inkRasterScale(bounds: Rect, devicePixelRatio: number): number {
  const density = Math.min(INK_RASTER_MAX_DPR, Math.max(1, devicePixelRatio || 1));
  return Math.min(density, INK_RASTER_MAX_SIDE / Math.max(bounds.width, bounds.height, 1));
}

/**
 * A cheap identity of the page's ink: which strokes, in which order, and a
 * little of each one's shape and colour. Tells whether the stored picture
 * still matches without drawing it again.
 */
export function inkFingerprint(strokes: readonly StrokeElementV2[]): string {
  let hash = 0x811c9dc5;
  const mix = (text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
  };
  for (const stroke of strokes) {
    const first = stroke.points[0];
    const last = stroke.points[stroke.points.length - 1];
    mix(`${stroke.id}|${stroke.points.length}|${first?.x},${first?.y}|${last?.x},${last?.y}|${stroke.color}|${stroke.size}|${stroke.opacity}|${stroke.tool};`);
  }
  return `${strokes.length}:${(hash >>> 0).toString(36)}`;
}

/**
 * Draws the strokes into a picture of `bounds` in idle slices of at most
 * RASTER_SLICE_MS, so a page of thousands of strokes never blocks the main
 * thread. Null when aborted or when the browser cannot encode it.
 */
export function renderInkRaster(
  strokes: readonly StrokeElementV2[],
  bounds: Rect,
  scale: number,
  signal?: AbortSignal,
): Promise<{ blob: Blob; width: number; height: number } | null> {
  const width = Math.max(1, Math.round(bounds.width * scale));
  const height = Math.max(1, Math.round(bounds.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return Promise.resolve(null);
  const scaleX = width / bounds.width;
  const scaleY = height / bounds.height;
  return new Promise((resolve) => {
    let next = 0;
    let cancel = () => {};
    const abort = () => {
      cancel();
      resolve(null);
    };
    if (signal?.aborted) {
      resolve(null);
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    cancel = whenIdle((budgetMs) => {
      if (signal?.aborted) return false;
      const started = performance.now();
      // The transform is set per slice: drawInkStroke resets only alpha and blending.
      context.setTransform(scaleX, 0, 0, scaleY, -bounds.x * scaleX, -bounds.y * scaleY);
      while (next < strokes.length && performance.now() - started < budgetMs) {
        drawInkStroke(context, strokes[next]);
        next += 1;
      }
      if (next < strokes.length) return true;
      signal?.removeEventListener("abort", abort);
      // A canvas that lost its backing store encodes as an empty picture,
      // which would replace a good stored one.
      if (isContextLost(context)) {
        resolve(null);
        return false;
      }
      // WebP keeps the transparency at a fraction of PNG's size; a browser
      // without a WebP encoder returns PNG, which works as well.
      canvas.toBlob((blob) => resolve(blob ? { blob, width, height } : null), "image/webp", 0.9);
      return false;
    }, RASTER_SLICE_MS);
  });
}

interface RasterJob {
  pageId: string;
  updatedAt: string;
  strokeCount: number;
  strokes: readonly StrokeElementV2[];
  frame: InkRasterFrame;
}

const sameRect = (left: Rect, right: Rect) =>
  left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;

/** Performance marks around writing a picture; the heavy-page benchmark reads them. */
export const INK_RASTER_MEASURE = "canvink:ink-raster";

async function runJob(job: RasterJob, signal: AbortSignal): Promise<void> {
  const store = inkRasterStore();
  if (!store) return;
  const region = inkRasterRegion(job.strokes, job.frame.visible);
  if (!region) {
    await store.remove(job.pageId);
    return;
  }
  const fingerprint = inkFingerprint(region.strokes);
  const stored = await store.load(job.pageId);
  const { frame } = job;
  const origin = { x: Math.round(frame.origin.x), y: Math.round(frame.origin.y) };
  if (
    stored
    && stored.fingerprint === fingerprint
    && stored.strokeCount === job.strokeCount
    && sameRect(stored.bounds, region.bounds)
    && stored.origin.x === origin.x && stored.origin.y === origin.y
    && sameRect(stored.view, frame.view)
    && sameRect(stored.paper, frame.paper) && stored.paper.color === frame.paper.color
  ) return;
  if (signal.aborted) return;
  const startMark = `${INK_RASTER_MEASURE}:start`;
  performance.mark(startMark);
  const scale = inkRasterScale(region.bounds, typeof window === "undefined" ? 1 : window.devicePixelRatio);
  const rendered = await renderInkRaster(region.strokes, region.bounds, scale, signal);
  if (!rendered || signal.aborted) return;
  const record: InkRasterRecord = {
    version: INK_RASTER_VERSION,
    pageId: job.pageId,
    bounds: region.bounds,
    width: rendered.width,
    height: rendered.height,
    origin,
    view: frame.view,
    paper: frame.paper,
    strokeCount: job.strokeCount,
    fingerprint,
    updatedAt: job.updatedAt,
    savedAt: Date.now(),
    blob: rendered.blob,
  };
  await store.save(record);
  performance.measure(INK_RASTER_MEASURE, startMark);
}

/** One picture is drawn at a time; a newer state of the same page replaces a queued or running one. */
const queued = new Map<string, RasterJob>();
let running: { pageId: string; controller: AbortController } | null = null;

function pump(): void {
  if (running) return;
  const next = queued.values().next();
  if (next.done) return;
  const job = next.value;
  queued.delete(job.pageId);
  const controller = new AbortController();
  running = { pageId: job.pageId, controller };
  void runJob(job, controller.signal).catch(() => undefined).finally(() => {
    running = null;
    pump();
  });
}

function scheduleJob(job: RasterJob): void {
  if (running?.pageId === job.pageId) running.controller.abort();
  queued.set(job.pageId, job);
  pump();
}

/** Pages whose real ink the open editor has painted. */
const paintedPages = new Set<string>();
const paintedListeners = new Set<(pageId: string) => void>();

/** Whether the open editor has painted this page's ink. */
export function inkPainted(pageId: string): boolean {
  return paintedPages.has(pageId);
}

/** Called after a frame showing a page's real ink has been painted. */
export function onInkPainted(listener: (pageId: string) => void): () => void {
  paintedListeners.add(listener);
  return () => paintedListeners.delete(listener);
}

export interface InkRasterSource {
  pageId: string;
  updatedAt: string;
  /** Live strokes on the page. */
  strokeCount: number;
  /** The page's ink runs, in page order. */
  runs: ReadonlyArray<{ readonly strokes: readonly StrokeElementV2[] }>;
  /** Where the page shows when it opens; null while it is not laid out. */
  measure: () => InkRasterFrame | null;
}

/**
 * The editor's side: reports when the page's real ink has been painted, and
 * keeps the page's picture up to date (drawn once the ink has not changed
 * for INK_RASTER_DEBOUNCE_MS, and at once when the page is left or the tab
 * is hidden with a change still pending).
 */
export function useInkRaster(source: InkRasterSource): void {
  const latest = useRef(source);
  useLayoutEffect(() => {
    latest.current = source;
  });
  const { pageId, runs } = source;
  const frame = useRef<InkRasterFrame | null>(null);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRef = useRef<(() => void) | null>(null);

  // The tiles are painted in the commit that mounts the layers; the second
  // animation frame after it comes after a frame that showed them.
  const shown = runs.length > 0 || source.strokeCount === 0;
  useEffect(() => {
    if (!shown) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        paintedPages.add(pageId);
        for (const listener of paintedListeners) listener(pageId);
      });
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
      paintedPages.delete(pageId);
    };
  }, [pageId, shown]);

  useEffect(() => {
    const measure = () => {
      try {
        frame.current = latest.current.measure() ?? frame.current;
      } catch {
        // Measuring is best effort; the last frame is kept.
      }
      return frame.current;
    };
    const capture = () => {
      pending.current = null;
      const current = latest.current;
      const measured = frame.current;
      if (!measured) return;
      scheduleJob({
        pageId: current.pageId,
        updatedAt: current.updatedAt,
        strokeCount: current.strokeCount,
        strokes: current.runs.flatMap((run) => run.strokes),
        frame: measured,
      });
    };
    measure();
    const hidden = () => {
      if (document.visibilityState !== "hidden" || pending.current === null) return;
      clearTimeout(pending.current);
      capture();
    };
    document.addEventListener("visibilitychange", hidden);
    const schedule = () => {
      if (pending.current !== null) clearTimeout(pending.current);
      pending.current = setTimeout(() => {
        measure();
        capture();
      }, INK_RASTER_DEBOUNCE_MS);
    };
    scheduleRef.current = schedule;
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      scheduleRef.current = null;
      // Leaving the page with a change not drawn yet: draw it now, with the
      // frame measured last (the editor is already being taken down).
      if (pending.current !== null) {
        clearTimeout(pending.current);
        capture();
      }
    };
  }, [pageId]);

  useEffect(() => {
    scheduleRef.current?.();
  }, [pageId, runs]);
}
