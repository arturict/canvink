/**
 * Limits and loss handling for every canvas the editor draws on.
 *
 * A browser shows a canvas as solid black or transparent, never as an error,
 * when its backing store is unusable: above the size or area it can allocate,
 * dropped under GPU memory pressure or after a GPU process crash (the
 * `contextlost` event), or presented through a low-latency path that a
 * Windows driver cannot serve. Nothing here depends on a canvas keeping its
 * pixels: sizes stay inside what browsers allocate, and a canvas that lost its
 * backing is painted again from the model.
 */

/** Longest canvas side in device pixels (Chromium allows 16,384; Safari and mobile browsers less). */
export const MAX_CANVAS_SIDE = 8192;
/** Largest canvas area in device pixels (Safari and iOS stop at 16,777,216). */
export const MAX_CANVAS_PIXELS = 16 * 1024 * 1024;
/** Most ink tiles one layer keeps as canvases at once. */
export const MAX_INK_TILES = 256;
/** Longest side of one ink tile in device pixels. */
export const MAX_TILE_SIDE = 4096;

export interface CanvasSize {
  width: number;
  height: number;
}

/**
 * The largest size at or below `width` x `height` that a browser allocates,
 * keeping the aspect ratio, in whole pixels of at least 1.
 */
export function clampCanvasSize(width: number, height: number): CanvasSize {
  const safeWidth = Number.isFinite(width) ? Math.max(1, Math.round(width)) : 1;
  const safeHeight = Number.isFinite(height) ? Math.max(1, Math.round(height)) : 1;
  const factor = Math.min(
    1,
    MAX_CANVAS_SIDE / safeWidth,
    MAX_CANVAS_SIDE / safeHeight,
    Math.sqrt(MAX_CANVAS_PIXELS / (safeWidth * safeHeight)),
  );
  if (factor >= 1) return { width: safeWidth, height: safeHeight };
  return {
    width: Math.max(1, Math.floor(safeWidth * factor)),
    height: Math.max(1, Math.floor(safeHeight * factor)),
  };
}

/** The device pixel ratio for a canvas covering `cssWidth` x `cssHeight`, lowered so its backing store stays allocatable. */
export function safeCanvasDpr(cssWidth: number, cssHeight: number, dpr: number): number {
  const wanted = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const width = Math.max(1, cssWidth);
  const height = Math.max(1, cssHeight);
  const factor = Math.min(
    1,
    MAX_CANVAS_SIDE / (width * wanted),
    MAX_CANVAS_SIDE / (height * wanted),
    Math.sqrt(MAX_CANVAS_PIXELS / (width * height * wanted * wanted)),
  );
  return wanted * factor;
}

/**
 * Tile side in page units for an ink layer: `base` (about 1,000 device pixels),
 * doubled while the part of the page in view would need more than MAX_INK_TILES
 * canvases, as long as a tile stays within MAX_TILE_SIDE device pixels.
 */
export function inkTileSize(
  base: number,
  scale: number,
  view: { x: number; y: number; width: number; height: number },
): number {
  let tile = base;
  const count = (side: number) =>
    (Math.floor((view.x + view.width) / side) - Math.floor(view.x / side) + 1)
    * (Math.floor((view.y + view.height) / side) - Math.floor(view.y / side) + 1);
  while (count(tile) > MAX_INK_TILES && Math.ceil(tile * 2 * scale) <= MAX_TILE_SIDE) tile *= 2;
  return tile;
}

/**
 * Calls `onLost` and `onRestored` for the browser dropping and recreating a
 * 2D canvas's backing store. A restored canvas is empty and its context state
 * is reset, so `onRestored` must paint everything again. Returns the unsubscribe.
 */
export function watchCanvasContext(
  canvas: HTMLCanvasElement,
  handlers: { onLost?: () => void; onRestored?: () => void },
): () => void {
  const lost = () => handlers.onLost?.();
  const restored = () => handlers.onRestored?.();
  canvas.addEventListener("contextlost", lost);
  canvas.addEventListener("contextrestored", restored);
  return () => {
    canvas.removeEventListener("contextlost", lost);
    canvas.removeEventListener("contextrestored", restored);
  };
}

/** Whether the browser reports the 2D context's backing store as dropped. */
export function isContextLost(context: CanvasRenderingContext2D): boolean {
  const probe = context as CanvasRenderingContext2D & { isContextLost?: () => boolean };
  return typeof probe.isContextLost === "function" && probe.isContextLost();
}

/** Calls `callback` whenever the tab becomes visible again; a hidden tab is where browsers drop canvas backings. Returns the unsubscribe. */
export function onTabVisible(callback: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  const listener = () => {
    if (document.visibilityState === "visible") callback();
  };
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}

const LOW_LATENCY_OFF_KEY = "canvink:overlay-low-latency-off";

/**
 * Whether the live-ink overlay may ask for a `desynchronized` (low-latency)
 * context. Once a canvas has lost its context on this device the flag stays
 * off, so the overlay uses the ordinary compositor path from then on.
 */
export function lowLatencyOverlayAllowed(): boolean {
  try {
    return window.localStorage.getItem(LOW_LATENCY_OFF_KEY) !== "1";
  } catch {
    return true;
  }
}

export function disableLowLatencyOverlay(): void {
  try {
    window.localStorage.setItem(LOW_LATENCY_OFF_KEY, "1");
  } catch {
    // Without storage the choice only lasts for this page load.
  }
}
