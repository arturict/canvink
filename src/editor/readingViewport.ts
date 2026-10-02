import type { Rect } from "./operations/geometry";

/**
 * The phone's reading view of a page (the Android app, see src/mobile). A
 * page opens fitted to the screen's width, pans only as far as it has
 * content, follows the finger past an edge with resistance, keeps moving
 * after a flick, and zooms with a double tap. These are the pure parts: the
 * page area worth showing, the zoom that fits it, how far the view may move,
 * and the motion curves. The editor applies them (LiveCanvasEditor's
 * `reading` prop).
 */

export interface ReadingViewport {
  zoom: number;
  panX: number;
  panY: number;
}

export interface ReadingInsets {
  /** Space the floating chrome covers at the top and bottom of the view, in CSS pixels. */
  top: number;
  bottom: number;
}

export interface ReadingBounds {
  minPanX: number;
  maxPanX: number;
  minPanY: number;
  maxPanY: number;
}

/** Space kept between the content and the screen's left and right edge. */
export const READING_SIDE_PADDING = 10;
/** Space kept above the first and below the last content. */
const READING_END_PADDING = 16;
/** A fitted page is never shown larger than this (a page with one short line). */
export const READING_MAX_FIT_ZOOM = 1.2;
/** Zoom limits of the reading view: the editor's own (clampCanvasZoom). */
export const READING_MIN_ZOOM = 0.25;
export const READING_MAX_ZOOM = 2.5;
/** Content narrower than this is fitted as if it were this wide. */
const MIN_CONTENT_WIDTH = 320;

/** Frames of the page's elements as the reader sees them (tombstoned ink is gone). */
export interface ReadingElement {
  kind: string;
  frame: { x: number; y: number; width: number; height: number };
  tombstonedAt?: string;
}

/**
 * The part of the page the reading view shows: a fixed sheet as a whole, a
 * free page from its origin (or its first content, for a page whose content
 * starts far down or to the right) to its last content.
 */
export function readingContentRect(
  elements: Iterable<ReadingElement>,
  sheet: { width: number; height: number } | null,
): Rect {
  if (sheet) return { x: 0, y: 0, width: sheet.width, height: sheet.height };
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const element of elements) {
    if (element.kind === "stroke" && element.tombstonedAt) continue;
    const { x, y, width, height } = element.frame;
    if (![x, y, width, height].every(Number.isFinite)) continue;
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x + width);
    bottom = Math.max(bottom, y + height);
  }
  if (!Number.isFinite(left)) return { x: 0, y: 0, width: MIN_CONTENT_WIDTH, height: 0 };
  // Content near the origin keeps the page's own left and top margin; content
  // that starts further in is shown from a small margin before it.
  const x = left < 160 ? 0 : Math.max(0, left - 24);
  const y = top < 240 ? 0 : Math.max(0, top - 24);
  const width = Math.max(MIN_CONTENT_WIDTH, right - x + (x === 0 ? Math.min(48, Math.max(0, left)) : 24));
  return { x, y, width, height: Math.max(0, bottom - y) };
}

export function clampReadingZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(READING_MAX_ZOOM, Math.max(READING_MIN_ZOOM, Math.round(zoom * 1000) / 1000));
}

/** The zoom that shows the content's whole width. */
export function fitZoom(content: Rect, viewWidth: number): number {
  const available = Math.max(1, viewWidth - READING_SIDE_PADDING * 2);
  return clampReadingZoom(Math.min(READING_MAX_FIT_ZOOM, available / Math.max(1, content.width)));
}

/** How far the view may pan at `zoom`. Content narrower than the view is centred. */
export function readingBounds(
  content: Rect,
  view: { width: number; height: number },
  zoom: number,
  insets: ReadingInsets,
): ReadingBounds {
  const width = content.width * zoom;
  let minPanX: number;
  let maxPanX: number;
  if (width + READING_SIDE_PADDING * 2 <= view.width) {
    minPanX = maxPanX = (view.width - width) / 2 - content.x * zoom;
  } else {
    maxPanX = READING_SIDE_PADDING - content.x * zoom;
    minPanX = view.width - READING_SIDE_PADDING - (content.x + content.width) * zoom;
  }
  const maxPanY = insets.top + READING_END_PADDING - content.y * zoom;
  const bottomEdge = view.height - insets.bottom - READING_END_PADDING - (content.y + content.height) * zoom;
  const minPanY = Math.min(maxPanY, bottomEdge);
  return { minPanX, maxPanX, minPanY, maxPanY };
}

export function clampToBounds(viewport: ReadingViewport, bounds: ReadingBounds): ReadingViewport {
  return {
    zoom: viewport.zoom,
    panX: Math.min(bounds.maxPanX, Math.max(bounds.minPanX, viewport.panX)),
    panY: Math.min(bounds.maxPanY, Math.max(bounds.minPanY, viewport.panY)),
  };
}

/** The view a page opens with: its content's width fitted, its top under the chrome. */
export function openingViewport(
  content: Rect,
  view: { width: number; height: number },
  insets: ReadingInsets,
): ReadingViewport {
  const zoom = fitZoom(content, view.width);
  const bounds = readingBounds(content, view, zoom, insets);
  return { zoom, panX: bounds.maxPanX, panY: bounds.maxPanY };
}

/**
 * The distance shown for `overshoot` pixels of finger travel past an edge:
 * it follows the finger with growing resistance and never reaches `limit`.
 */
export function rubberBand(overshoot: number, limit: number): number {
  if (overshoot === 0 || limit <= 0) return 0;
  const magnitude = Math.abs(overshoot);
  return Math.sign(overshoot) * limit * (1 - 1 / ((magnitude * 0.55) / limit + 1));
}

/**
 * Where a finger drag puts the view: inside the bounds it follows the finger,
 * past them it stretches (see rubberBand). Returns the overshoot in finger
 * pixels as well, which decides a page swipe.
 */
export function dragViewport(
  wanted: ReadingViewport,
  bounds: ReadingBounds,
  limit: { x: number; y: number },
): { viewport: ReadingViewport; overshoot: { x: number; y: number } } {
  const clamped = clampToBounds(wanted, bounds);
  const overshoot = { x: wanted.panX - clamped.panX, y: wanted.panY - clamped.panY };
  return {
    viewport: {
      zoom: wanted.zoom,
      panX: clamped.panX + rubberBand(overshoot.x, limit.x),
      panY: clamped.panY + rubberBand(overshoot.y, limit.y),
    },
    overshoot,
  };
}

/**
 * The axis a drag moves along. A page that fits the screen's width scrolls
 * vertically only, unless the finger clearly goes sideways (a page swipe);
 * a zoomed-in page pans freely.
 */
export type DragAxis = "free" | "x" | "y";

export function dragAxis(delta: { x: number; y: number }, horizontalRoom: boolean): DragAxis | null {
  const distance = Math.hypot(delta.x, delta.y);
  if (distance < 8) return null;
  if (horizontalRoom) return "free";
  return Math.abs(delta.x) > Math.abs(delta.y) * 1.2 ? "x" : "y";
}

/** Finger travel past the left or right edge that turns the page. */
export const PAGE_SWIPE_DISTANCE = 72;
/** A quick flick past an edge turns the page after less travel. */
const PAGE_SWIPE_FLICK_DISTANCE = 32;
const PAGE_SWIPE_FLICK_SPEED = 0.6;

/** The page a released drag turns to: "next" for a swipe to the left. */
export function pageSwipe(
  overshootX: number,
  velocityX: number,
  axis: DragAxis | null,
): "next" | "previous" | null {
  if (axis === "y" || axis === null) return null;
  const flick = Math.abs(velocityX) >= PAGE_SWIPE_FLICK_SPEED && Math.sign(velocityX) === Math.sign(overshootX);
  const needed = flick ? PAGE_SWIPE_FLICK_DISTANCE : PAGE_SWIPE_DISTANCE;
  if (Math.abs(overshootX) < needed) return null;
  return overshootX < 0 ? "next" : "previous";
}

/** Velocity of the last part of a drag in pixels per millisecond, from timed samples. */
export function releaseVelocity(samples: ReadonlyArray<{ x: number; y: number; time: number }>, window = 80): { x: number; y: number } {
  if (samples.length < 2) return { x: 0, y: 0 };
  const last = samples[samples.length - 1];
  let first = samples[samples.length - 2];
  for (let index = samples.length - 2; index >= 0; index -= 1) {
    if (last.time - samples[index].time > window) break;
    first = samples[index];
  }
  const elapsed = last.time - first.time;
  if (elapsed <= 0) return { x: 0, y: 0 };
  // A finger that stopped before lifting does not fling.
  return { x: (last.x - first.x) / elapsed, y: (last.y - first.y) / elapsed };
}

/** Velocity below which a fling stops, in pixels per millisecond. */
const FLING_MIN_SPEED = 0.02;
/** Velocity kept per millisecond of a fling (Android's scroller loses about this much). */
const FLING_FRICTION = 0.9972;
/** Flings start no faster than this. */
const FLING_MAX_SPEED = 8;

export function capVelocity(velocity: { x: number; y: number }): { x: number; y: number } {
  const speed = Math.hypot(velocity.x, velocity.y);
  if (speed <= FLING_MAX_SPEED) return velocity;
  return { x: (velocity.x / speed) * FLING_MAX_SPEED, y: (velocity.y / speed) * FLING_MAX_SPEED };
}

/**
 * One frame of a fling: moves by the velocity, slows down, and stops an axis
 * at its bound. Returns null when the fling is over.
 */
export function flingStep(
  viewport: ReadingViewport,
  velocity: { x: number; y: number },
  bounds: ReadingBounds,
  elapsed: number,
): { viewport: ReadingViewport; velocity: { x: number; y: number } } | null {
  const decay = Math.pow(FLING_FRICTION, elapsed);
  let vx = velocity.x * decay;
  let vy = velocity.y * decay;
  // The distance covered is the integral of the decaying velocity.
  const factor = Math.abs(Math.log(FLING_FRICTION)) > 0 ? (1 - decay) / -Math.log(FLING_FRICTION) : elapsed;
  let panX = viewport.panX + velocity.x * factor;
  let panY = viewport.panY + velocity.y * factor;
  if (panX <= bounds.minPanX || panX >= bounds.maxPanX) {
    panX = Math.min(bounds.maxPanX, Math.max(bounds.minPanX, panX));
    vx = 0;
  }
  if (panY <= bounds.minPanY || panY >= bounds.maxPanY) {
    panY = Math.min(bounds.maxPanY, Math.max(bounds.minPanY, panY));
    vy = 0;
  }
  const next = { zoom: viewport.zoom, panX, panY };
  if (Math.hypot(vx, vy) < FLING_MIN_SPEED) return panX === viewport.panX && panY === viewport.panY ? null : { viewport: next, velocity: { x: 0, y: 0 } };
  return { viewport: next, velocity: { x: vx, y: vy } };
}

/** Zooms about `anchor` (view coordinates). */
export function zoomAround(viewport: ReadingViewport, zoom: number, anchor: { x: number; y: number }): ReadingViewport {
  const next = clampReadingZoom(zoom);
  const worldX = (anchor.x - viewport.panX) / viewport.zoom;
  const worldY = (anchor.y - viewport.panY) / viewport.zoom;
  return { zoom: next, panX: anchor.x - worldX * next, panY: anchor.y - worldY * next };
}

/**
 * Double tap: a page at (or near) its fitted width zooms in on the tapped
 * spot, a zoomed-in page returns to the fitted width.
 */
export function doubleTapViewport(
  viewport: ReadingViewport,
  anchor: { x: number; y: number },
  content: Rect,
  view: { width: number; height: number },
  insets: ReadingInsets,
): ReadingViewport {
  const fit = fitZoom(content, view.width);
  if (viewport.zoom > fit * 1.15) {
    const bounds = readingBounds(content, view, fit, insets);
    // Back to the fitted width, keeping the tapped line where it was.
    const worldY = (anchor.y - viewport.panY) / viewport.zoom;
    return clampToBounds({ zoom: fit, panX: bounds.maxPanX, panY: anchor.y - worldY * fit }, bounds);
  }
  const target = clampReadingZoom(Math.max(fit * 2.2, Math.min(1.4, fit * 3)));
  const zoomed = zoomAround(viewport, target, anchor);
  return clampToBounds(zoomed, readingBounds(content, view, target, insets));
}

/**
 * The view that shows `target` (page units) at a comfortable reading size:
 * its width fitted (at most `maxZoom`), its top just below the chrome.
 */
export function viewportForRegion(
  target: Rect,
  content: Rect,
  view: { width: number; height: number },
  insets: ReadingInsets,
  maxZoom = 1.25,
): ReadingViewport {
  const zoom = clampReadingZoom(Math.min(maxZoom, Math.max(fitZoom(content, view.width), (view.width - READING_SIDE_PADDING * 2) / Math.max(1, target.width))));
  const bounds = readingBounds(content, view, zoom, insets);
  return clampToBounds({
    zoom,
    panX: READING_SIDE_PADDING - target.x * zoom,
    panY: insets.top + READING_END_PADDING - target.y * zoom,
  }, bounds);
}

/** Material's emphasized-decelerate curve, close enough for view animations. */
export function easeOutCubic(progress: number): number {
  const clamped = Math.min(1, Math.max(0, progress));
  return 1 - Math.pow(1 - clamped, 3);
}

export function interpolateViewport(from: ReadingViewport, to: ReadingViewport, progress: number): ReadingViewport {
  const eased = easeOutCubic(progress);
  // Zoom moves geometrically so the anchor between the two views stays put.
  const zoom = from.zoom * Math.pow(to.zoom / from.zoom, eased);
  return {
    zoom,
    panX: from.panX + (to.panX - from.panX) * eased,
    panY: from.panY + (to.panY - from.panY) * eased,
  };
}
