import type { Point } from "./operations";
import {
  clampCanvasSize,
  disableLowLatencyOverlay,
  isContextLost,
  lowLatencyOverlayAllowed,
  safeCanvasDpr,
  watchCanvasContext,
  type CanvasSize,
} from "./canvasSafety";
import { drawInkStroke, type InkStroke } from "./ink";

/**
 * The stroke under the pen is painted on one canvas above the page, straight
 * from the pointer handler: no React state, no re-render, no DOM change per
 * pointer move. The same canvas shows the lasso loop, the eraser trail and
 * shape guides while they are drawn.
 */
export interface OverlayTransform {
  /** CSS pixels from the overlay's top-left corner to the page origin. */
  originX: number;
  originY: number;
  zoom: number;
  dpr: number;
}

export type OverlayGuide = "lasso" | "eraser" | "shape" | "rect";

/**
 * The overlay's 2D context. `desynchronized` lets the browser present the
 * canvas without waiting for the compositor's next frame where the platform
 * supports it (Chromium on Windows, ChromeOS and Android, so WebView2 as well),
 * which takes up to a frame off the pen's latency; elsewhere it is ignored.
 * The attribute counts only for the first call on a canvas. Some Windows
 * drivers present such a canvas as solid black after a context loss, so a loss
 * switches it off for this device (the next overlay is created without it) and
 * hides the overlay until something is painted on it again.
 */
export function overlayContext(overlay: HTMLCanvasElement): CanvasRenderingContext2D | null {
  overlayHealthOf(overlay);
  const context = overlay.getContext("2d", lowLatencyOverlayAllowed() ? { desynchronized: true } : undefined);
  return context && !isContextLost(context) ? context : null;
}

interface OverlayHealth {
  /** The backing store was dropped or restored: whatever was drawn is gone. */
  stale: boolean;
}

const overlayHealth = new WeakMap<HTMLCanvasElement, OverlayHealth>();

/**
 * Starts watching the overlay for losing its backing store (idempotent). The
 * editor calls it when the overlay mounts, so a loss before the first stroke
 * is noticed too. The watch lives as long as the canvas.
 */
export function watchOverlay(overlay: HTMLCanvasElement): void {
  overlayHealthOf(overlay);
}

function overlayHealthOf(overlay: HTMLCanvasElement): OverlayHealth {
  const known = overlayHealth.get(overlay);
  if (known) return known;
  const health: OverlayHealth = { stale: false };
  overlayHealth.set(overlay, health);
  const dropped = () => {
    health.stale = true;
    disableLowLatencyOverlay();
    // An empty overlay is invisible, so a canvas that shows black cannot cover the page.
    setOverlayShown(overlay, false);
  };
  watchCanvasContext(overlay, { onLost: dropped, onRestored: dropped });
  return health;
}

/**
 * Whether the overlay lost its backing store since the last call, which means
 * everything on it has to be painted again. Reading clears the mark.
 */
export function takeOverlayStale(overlay: HTMLCanvasElement): boolean {
  const health = overlayHealthOf(overlay);
  const stale = health.stale;
  health.stale = false;
  return stale;
}

/**
 * The overlay is shown only while something is on it, so a canvas whose
 * backing store is unusable and that a driver presents as black is never
 * visible over the page.
 */
export function setOverlayShown(overlay: HTMLCanvasElement, shown: boolean): void {
  overlay.style.visibility = shown ? "visible" : "hidden";
}

export function overlayTransform(
  overlay: HTMLCanvasElement,
  surface: HTMLElement,
  zoom: number,
): OverlayTransform {
  const overlayRect = overlay.getBoundingClientRect();
  const surfaceRect = surface.getBoundingClientRect();
  return {
    originX: surfaceRect.left - overlayRect.left,
    originY: surfaceRect.top - overlayRect.top,
    zoom,
    // Lowered where a big window on a dense screen would exceed what a browser allocates.
    dpr: safeCanvasDpr(
      overlay.clientWidth,
      overlay.clientHeight,
      typeof window === "undefined" ? 1 : window.devicePixelRatio || 1,
    ),
  };
}

/** The backing-store size for the overlay at `transform`, inside what browsers allocate. */
export function overlayBackingSize(overlay: HTMLCanvasElement, transform: OverlayTransform): CanvasSize {
  return clampCanvasSize(overlay.clientWidth * transform.dpr, overlay.clientHeight * transform.dpr);
}

/** Matches the backing store to the overlay's size and clears it. */
export function beginOverlay(
  overlay: HTMLCanvasElement,
  transform: OverlayTransform,
): CanvasRenderingContext2D | null {
  const { width, height } = overlayBackingSize(overlay, transform);
  if (overlay.width !== width) overlay.width = width;
  if (overlay.height !== height) overlay.height = height;
  const context = overlayContext(overlay);
  if (!context) return null;
  takeOverlayStale(overlay);
  setOverlayShown(overlay, true);
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, width, height);
  context.setTransform(
    transform.dpr * transform.zoom,
    0,
    0,
    transform.dpr * transform.zoom,
    transform.dpr * transform.originX,
    transform.dpr * transform.originY,
  );
  return context;
}

export function clearOverlay(overlay: HTMLCanvasElement | null): void {
  if (!overlay) return;
  setOverlayShown(overlay, false);
  const context = overlayContext(overlay);
  if (!context) return;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, overlay.width, overlay.height);
}

/**
 * Repaints the overlay: strokes already committed but not yet on their tile
 * (so nothing flickers between pen-up and the page re-render), then the live
 * stroke with an open end.
 */
export function paintLiveInk(
  overlay: HTMLCanvasElement,
  transform: OverlayTransform,
  settled: readonly InkStroke[],
  live: InkStroke | null,
): void {
  const context = beginOverlay(overlay, transform);
  if (!context) return;
  for (const stroke of settled) drawInkStroke(context, stroke);
  if (live && live.points.length > 0) drawInkStroke(context, live, false);
}

export function paintGuide(
  overlay: HTMLCanvasElement,
  transform: OverlayTransform,
  points: readonly Point[],
  guide: OverlayGuide,
): void {
  const context = beginOverlay(overlay, transform);
  if (!context || points.length === 0) return;
  const unit = 1 / transform.zoom;
  context.beginPath();
  if (guide === "rect") {
    // The dragged rectangle of a rectangle selection or screen clip: the two
    // corners are the first and the last point.
    const last = points[points.length - 1];
    context.rect(points[0].x, points[0].y, last.x - points[0].x, last.y - points[0].y);
    context.fillStyle = "rgb(37 99 235 / 8%)";
    context.fill();
    context.setLineDash([6 * unit, 4 * unit]);
    context.strokeStyle = "#2563eb";
    context.lineWidth = 1.5 * unit;
    context.stroke();
    context.setLineDash([]);
    return;
  }
  context.moveTo(points[0].x, points[0].y);
  for (let index = 1; index < points.length; index += 1) context.lineTo(points[index].x, points[index].y);
  context.lineCap = "round";
  context.lineJoin = "round";
  if (guide === "lasso") {
    context.closePath();
    context.fillStyle = "rgb(37 99 235 / 6%)";
    context.fill();
    context.setLineDash([6 * unit, 4 * unit]);
    context.strokeStyle = "#2563eb";
    context.lineWidth = 1.5 * unit;
  } else if (guide === "eraser") {
    context.strokeStyle = "rgb(100 116 139 / 35%)";
    context.lineWidth = 12;
  } else {
    context.strokeStyle = "#2563eb";
    context.lineWidth = 2 * unit;
  }
  context.stroke();
  context.setLineDash([]);
}
