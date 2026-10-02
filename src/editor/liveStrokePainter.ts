import type { StrokePointV2 } from '../domain/v2';
import { drawInkStroke, type InkStroke } from './ink';
import { strokeBounds } from './inkGeometry';
import {
  appendSegment,
  pathSpacing,
  radiusForPressure,
  type PathPoint,
  type WidthShape,
} from './inkPath';
import {
  beginOverlay,
  overlayBackingSize,
  overlayContext,
  setOverlayShown,
  takeOverlayStale,
  type OverlayTransform,
} from './liveInkOverlay';
import { naturalPressure } from './penInput';

/**
 * The stroke under the pen, painted a piece at a time.
 *
 * Re-filling the whole outline on a cleared canvas for every pointer event
 * costs more the longer the stroke gets, and clears a canvas as big as the
 * screen each time. Here the path through the samples (the same one the
 * finished stroke is built from, see inkPath) grows by the new samples only.
 * What is still provisional, the last segments and the browser's predicted
 * tail, is the only part that is wiped and repainted, inside a small
 * rectangle; everything before it stays on the canvas as it was drawn.
 */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Below this a pen's pressure is not a reading but the contact itself. */
const CONTACT_PRESSURE = 0.001;
/** Diameters closer than this share one canvas stroke call. */
const WIDTH_STEP = 0.12;

export function emptyBox(): Box {
  return { left: Number.POSITIVE_INFINITY, top: Number.POSITIVE_INFINITY, right: Number.NEGATIVE_INFINITY, bottom: Number.NEGATIVE_INFINITY };
}

export function growBox(box: Box, x: number, y: number): void {
  if (x < box.left) box.left = x;
  if (y < box.top) box.top = y;
  if (x > box.right) box.right = x;
  if (y > box.bottom) box.bottom = y;
}

export function isEmptyBox(box: Box): boolean {
  return box.left > box.right || box.top > box.bottom;
}

export interface WidthRun {
  diameter: number;
  points: PathPoint[];
}

/** Cuts a path into runs of about equal width, each of which is one canvas stroke. */
export function widthRuns(path: readonly PathPoint[], shape: WidthShape): WidthRun[] {
  const runs: WidthRun[] = [];
  for (const point of path) {
    const diameter = 2 * radiusForPressure(shape, point.pressure);
    const current: WidthRun | undefined = runs[runs.length - 1];
    if (!current || Math.abs(diameter - current.diameter) > WIDTH_STEP) {
      // A new run starts at the last point of the old one, so there is no gap between them.
      const joint = current?.points[current.points.length - 1];
      runs.push({ diameter, points: joint ? [joint, point] : [point] });
    } else {
      current.points.push(point);
    }
  }
  return runs;
}

/**
 * The growing path of a live stroke: what is settled, and what is still
 * provisional. Free of any canvas, so the rules are testable on their own.
 */
export class LiveStrokePath {
  readonly shape: WidthShape;
  readonly spacing: number;
  /** Dense path through every sample up to the last settled segment. */
  readonly settled: PathPoint[] = [];
  /** Distinct samples taken in so far. */
  private readonly samples: PathPoint[] = [];
  private taken = 0;
  private settledSegments = 0;
  private lastPressure: number | undefined;

  constructor(shape: WidthShape) {
    this.shape = shape;
    this.spacing = pathSpacing(shape.size);
  }

  /**
   * Same shaping as the finished stroke: the pressure a pen reports as 0 at
   * contact is the one before it, then the natural curve. A predicted sample
   * never becomes the pressure that later samples inherit.
   */
  private shaped(sample: StrokePointV2, remember = true): PathPoint {
    const reported = sample.pressure > CONTACT_PRESSURE;
    if (reported && remember) this.lastPressure = sample.pressure;
    const pressure = reported ? sample.pressure : this.lastPressure ?? 0.5;
    return { x: sample.x, y: sample.y, pressure: naturalPressure(pressure) };
  }

  /**
   * Takes in the samples that came since the last call (the array only grows)
   * and settles every segment that has all four of its neighbours. Returns
   * the settled points that are new.
   */
  take(samples: readonly StrokePointV2[]): PathPoint[] {
    for (; this.taken < samples.length; this.taken += 1) {
      const point = this.shaped(samples[this.taken]);
      const previous = this.samples[this.samples.length - 1];
      if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) < 0.05) continue;
      this.samples.push(point);
    }
    const before = this.settled.length;
    if (this.settled.length === 0 && this.samples.length > 0) this.settled.push({ ...this.samples[0] });
    while (this.settledSegments + 2 < this.samples.length) {
      appendSegment(this.samples, this.settledSegments, this.spacing, this.settled);
      this.settledSegments += 1;
    }
    return this.settled.slice(before);
  }

  /**
   * The provisional end: the segments after the settled ones, up to the
   * newest sample and then through the predicted ones. Starts at the last
   * settled point so that it joins the rest.
   */
  tail(predicted: readonly StrokePointV2[]): PathPoint[] {
    const start = this.settled[this.settled.length - 1];
    if (!start) return [];
    const windowStart = Math.max(0, this.settledSegments - 1);
    const window = [...this.samples.slice(windowStart), ...predicted.map((sample) => this.shaped(sample, false))];
    const path: PathPoint[] = [start];
    for (let index = this.settledSegments - windowStart; index + 1 < window.length; index += 1) {
      appendSegment(window, index, this.spacing, path);
    }
    return path;
  }

  get sampleCount(): number {
    return this.samples.length;
  }
}

function boundsOf(points: readonly PathPoint[], into: Box): void {
  for (const point of points) growBox(into, point.x, point.y);
}

function drawRuns(context: CanvasRenderingContext2D, runs: readonly WidthRun[]): void {
  for (const run of runs) {
    context.lineWidth = run.diameter;
    context.beginPath();
    const [first, ...rest] = run.points;
    context.moveTo(first.x, first.y);
    // A single point is a dot: a zero-length line with round caps.
    if (rest.length === 0) context.lineTo(first.x, first.y);
    for (const point of rest) context.lineTo(point.x, point.y);
    context.stroke();
  }
}

export interface LiveStrokeStyle {
  color: string;
  shape: WidthShape;
}

export class LiveStrokePainter {
  private readonly overlay: HTMLCanvasElement;
  private readonly transform: OverlayTransform;
  private readonly style: LiveStrokeStyle;
  private readonly settledInk: () => readonly InkStroke[];
  private readonly path: LiveStrokePath;
  private tailBox: Box = emptyBox();
  private lastTail: readonly PathPoint[] = [];
  private drawnSettled = 0;
  private readonly padding: number;

  constructor(
    overlay: HTMLCanvasElement,
    transform: OverlayTransform,
    style: LiveStrokeStyle,
    settledInk: () => readonly InkStroke[],
  ) {
    this.overlay = overlay;
    this.transform = transform;
    this.style = style;
    this.settledInk = settledInk;
    this.path = new LiveStrokePath(style.shape);
    this.padding = radiusForPressure(style.shape, 1) + 1.5;
    // While no stroke is drawn the overlay shows the strokes that wait for
    // their tile, so there is nothing to clear when a stroke starts. Only a
    // canvas of the wrong size (it starts out 300 x 150, and a resize empties
    // it) is set up again and the waiting strokes painted back; after that
    // only small rectangles are ever wiped.
    const { width, height } = overlayBackingSize(overlay, transform);
    if (overlay.width !== width || overlay.height !== height || takeOverlayStale(overlay)) {
      const context = beginOverlay(overlay, transform);
      if (context) for (const stroke of settledInk()) drawInkStroke(context, stroke);
    }
    setOverlayShown(overlay, true);
  }

  /** The whole canvas in page units, for painting everything again. */
  private wholeCanvas(): Box {
    const { dpr, zoom, originX, originY } = this.transform;
    const scale = zoom * dpr;
    return {
      left: -originX * dpr / scale,
      top: -originY * dpr / scale,
      right: (this.overlay.width - originX * dpr) / scale,
      bottom: (this.overlay.height - originY * dpr) / scale,
    };
  }

  /**
   * Strokes that were written to the page now show on their tile: wipes them
   * from the overlay, keeping everything else the overlay shows.
   */
  erase(strokes: readonly InkStroke[]): void {
    const context = overlayContext(this.overlay);
    if (!context || strokes.length === 0) return;
    const region = emptyBox();
    for (const stroke of strokes) {
      const bounds = strokeBounds(stroke);
      growBox(region, bounds.x - stroke.size, bounds.y - stroke.size);
      growBox(region, bounds.x + bounds.width + stroke.size, bounds.y + bounds.height + stroke.size);
    }
    this.repaint(context, region, this.lastTail);
  }

  /** `samples` is the whole stroke so far (it only grows); `predicted` is not stored anywhere. */
  update(samples: readonly StrokePointV2[], predicted: readonly StrokePointV2[]): void {
    const context = overlayContext(this.overlay);
    if (!context) return;
    const fresh = this.path.take(samples);
    const tail = this.path.tail(predicted);
    if (takeOverlayStale(this.overlay)) {
      // The browser dropped the canvas's backing store: all of it is empty, so
      // everything the overlay shows is painted again, not only the changed part.
      setOverlayShown(this.overlay, true);
      this.tailBox = emptyBox();
      boundsOf(tail, this.tailBox);
      this.lastTail = tail;
      this.drawnSettled = this.path.settled.length;
      this.repaint(context, this.wholeCanvas(), tail);
      return;
    }
    const region = emptyBox();
    if (!isEmptyBox(this.tailBox)) {
      region.left = this.tailBox.left;
      region.top = this.tailBox.top;
      region.right = this.tailBox.right;
      region.bottom = this.tailBox.bottom;
    }
    boundsOf(fresh, region);
    // The settled point just before the new ones joins them, and the old tail
    // started at the settled end, so its bounds are already part of the region.
    const joint = this.path.settled[this.drawnSettled - 1];
    if (joint) growBox(region, joint.x, joint.y);
    boundsOf(tail, region);
    this.tailBox = emptyBox();
    boundsOf(tail, this.tailBox);
    this.lastTail = tail;
    if (isEmptyBox(region)) return;
    this.drawnSettled = this.path.settled.length;
    this.repaint(context, region, tail);
  }

  private repaint(context: CanvasRenderingContext2D, region: Box, tail: readonly PathPoint[]): void {
    const { dpr, zoom, originX, originY } = this.transform;
    const pad = this.padding;
    // The wiped rectangle is whole device pixels, so its edges are neither
    // half-cleared nor painted over twice.
    const left = Math.floor((region.left - pad) * zoom * dpr + originX * dpr);
    const top = Math.floor((region.top - pad) * zoom * dpr + originY * dpr);
    const right = Math.ceil((region.right + pad) * zoom * dpr + originX * dpr);
    const bottom = Math.ceil((region.bottom + pad) * zoom * dpr + originY * dpr);
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.save();
    context.beginPath();
    context.rect(left, top, right - left, bottom - top);
    context.clip();
    context.clearRect(left, top, right - left, bottom - top);
    context.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * originX, dpr * originY);
    const page: Box = {
      left: (left - originX * dpr) / (zoom * dpr),
      top: (top - originY * dpr) / (zoom * dpr),
      right: (right - originX * dpr) / (zoom * dpr),
      bottom: (bottom - originY * dpr) / (zoom * dpr),
    };
    for (const stroke of this.settledInk()) {
      const bounds = strokeBounds(stroke);
      const reach = stroke.size;
      if (
        bounds.x - reach > page.right || bounds.x + bounds.width + reach < page.left
        || bounds.y - reach > page.bottom || bounds.y + bounds.height + reach < page.top
      ) continue;
      drawInkStroke(context, stroke);
    }
    context.strokeStyle = this.style.color;
    context.fillStyle = this.style.color;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.globalAlpha = 1;
    context.globalCompositeOperation = 'source-over';
    // Settled path: only the stretches that reach into the wiped rectangle.
    const settled = this.path.settled;
    const reaches = (point: PathPoint) =>
      point.x + pad >= page.left && point.x - pad <= page.right && point.y + pad >= page.top && point.y - pad <= page.bottom;
    let index = 0;
    while (index < settled.length) {
      if (!reaches(settled[index])) {
        index += 1;
        continue;
      }
      const from = Math.max(0, index - 1);
      while (index < settled.length && reaches(settled[index])) index += 1;
      const to = Math.min(settled.length - 1, index);
      drawRuns(context, widthRuns(settled.slice(from, to + 1), this.style.shape));
    }
    if (tail.length > 0) drawRuns(context, widthRuns(tail, this.style.shape));
    context.restore();
  }
}
