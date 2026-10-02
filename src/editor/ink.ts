import { getStroke, type StrokeOptions } from 'perfect-freehand';
import type { InkPoint, StrokeElement } from '../domain/types';
import type { StrokeElementV2 } from '../domain/v2';
import { penOutline, contactPressures } from './inkPath';
import { naturalPressure, smoothPressures, tiltPressure } from './penInput';

export type OutlinePoint = [number, number];

const PEN_OUTLINE: StrokeOptions = {
  thinning: 0.62,
  smoothing: 0.62,
  streamline: 0.42,
  easing: (value) => value,
  start: { cap: true, taper: 0 },
  end: { cap: true, taper: 0 },
};

/**
 * A digitizer's samples are clean, so they need far less smoothing than a
 * mouse: heavy streamlining rounds off small letters and exponents.
 */
const PEN_WITH_PRESSURE: StrokeOptions = {
  ...PEN_OUTLINE,
  smoothing: 0.5,
  streamline: 0.2,
  simulatePressure: false,
};

/** How strongly a pen's pressure changes the width of its line. */
export const PEN_THINNING = PEN_WITH_PRESSURE.thinning ?? 0.5;

/**
 * Mouse and finger input has no pressure. Its width follows drawing speed,
 * but only gently: fast mouse writing must not thin out to a hairline.
 */
const SIMULATED_OUTLINE: StrokeOptions = {
  ...PEN_OUTLINE,
  thinning: 0.3,
  simulatePressure: true,
};

/** A highlighter lays down an even band; pressure does not change its width. */
const HIGHLIGHTER_OUTLINE: StrokeOptions = {
  ...PEN_OUTLINE,
  thinning: 0,
  simulatePressure: false,
};

/** A pen's highlighter gets broader as the pen tilts, see `tiltPressure`. */
const HIGHLIGHTER_TILT_OUTLINE: StrokeOptions = {
  ...HIGHLIGHTER_OUTLINE,
  smoothing: 0.5,
  streamline: 0.2,
  thinning: 0.5,
};

export function getStrokeOutline(
  points: InkPoint[],
  size: number,
  simulatePressure = true,
): OutlinePoint[] {
  if (points.length === 0) return [];
  return getStroke(
    points.map((point) => [point.x, point.y, point.pressure]),
    { ...PEN_OUTLINE, size, simulatePressure },
  ) as OutlinePoint[];
}

const round = (value: number) => Math.round(value * 100) / 100;

export function outlineToSvgPath(points: OutlinePoint[]): string {
  if (points.length < 2) return '';
  const first = points[0];
  let path = `M ${round(first[0])} ${round(first[1])}`;

  for (let index = 1; index < points.length; index += 1) {
    const point = points[index];
    const next = points[(index + 1) % points.length];
    path += ` Q ${round(point[0])} ${round(point[1])} ${round((point[0] + next[0]) / 2)} ${round((point[1] + next[1]) / 2)}`;
  }

  return `${path} Z`;
}

export function strokeToSvgPath(stroke: Pick<StrokeElement, 'points' | 'size'>): string {
  const pointerIsPen = stroke.points.some((point) => point.pointerType === 'pen');
  return outlineToSvgPath(getStrokeOutline(stroke.points, stroke.size, !pointerIsPen));
}

export type InkStroke = Pick<StrokeElementV2, 'points' | 'size' | 'tool' | 'color' | 'opacity'>;

/**
 * Pen input carries real pressure. Mouse and touch report a constant, so
 * their width is simulated from drawing speed instead, as in OneNote.
 */
export function strokeHasPressure(stroke: Pick<StrokeElementV2, 'points'>): boolean {
  return stroke.points.some((point) => point.pointerType === 'pen');
}

const outlineCache = new WeakMap<object, OutlinePoint[]>();

/**
 * The filled outline of a stroke, shared by the screen and the exports so
 * both show the same pressure-shaped ink. `complete` is false while the pen
 * is still down, which keeps the end of the live stroke from being capped
 * early. Finished strokes are cached per stroke version.
 */
export function inkOutline(stroke: InkStroke, complete = true): OutlinePoint[] {
  if (stroke.points.length === 0) return [];
  if (complete) {
    const cached = outlineCache.get(stroke);
    if (cached) return cached;
  }
  const pen = strokeHasPressure(stroke);
  const highlighter = stroke.tool === 'highlighter';
  const options = highlighter
    ? pen ? HIGHLIGHTER_TILT_OUTLINE : HIGHLIGHTER_OUTLINE
    : pen ? PEN_WITH_PRESSURE : SIMULATED_OUTLINE;
  // Pen pressure goes through the natural curve and a light smoothing pass;
  // the highlighter's width follows the pen's tilt instead. Without real
  // pressure the reported value is meaningless (and still seeds
  // perfect-freehand's starting width), so it is neutralised.
  const pressures = !pen
    ? stroke.points.map(() => 0.5)
    : highlighter
      ? stroke.points.map((point) => tiltPressure(point.tiltX, point.tiltY))
      : smoothPressures(contactPressures(stroke.points.map((point) => point.pressure)).map(naturalPressure));
  // A pen's samples go through their own path (see inkPath); only mouse and
  // touch strokes, whose width follows speed, still use perfect-freehand's
  // streamlining.
  const outline = pen
    ? penOutline(
        stroke.points.map((point, index) => ({ x: point.x, y: point.y, pressure: pressures[index] })),
        { size: stroke.size, thinning: options.thinning ?? 0.5 },
      )
    : getStroke(
        stroke.points.map((point, index) => [point.x, point.y, pressures[index]]),
        { ...options, size: stroke.size, last: complete },
      ) as OutlinePoint[];
  if (complete) outlineCache.set(stroke, outline);
  return outline;
}

const pathCache = new WeakMap<object, Path2D>();

function outlinePath(outline: readonly OutlinePoint[]): Path2D {
  const path = new Path2D();
  if (outline.length === 0) return path;
  path.moveTo(outline[0][0], outline[0][1]);
  for (let index = 1; index < outline.length; index += 1) {
    const point = outline[index];
    const next = outline[(index + 1) % outline.length];
    path.quadraticCurveTo(point[0], point[1], (point[0] + next[0]) / 2, (point[1] + next[1]) / 2);
  }
  path.closePath();
  return path;
}

/**
 * Builds a finished stroke's outline and path ahead of painting it, so that
 * painting a tile later only has to fill. Returns false when both were
 * already there.
 */
export function prepareInkStroke(stroke: InkStroke): boolean {
  if (pathCache.has(stroke)) return false;
  pathCache.set(stroke, outlinePath(inkOutline(stroke)));
  return true;
}

/**
 * Paints one stroke in page units. The highlighter multiplies with what is
 * already on the layer, so pen ink under it stays dark instead of being
 * washed out; its layer also multiplies with the paper and printouts below.
 */
export function drawInkStroke(
  context: CanvasRenderingContext2D,
  stroke: InkStroke,
  complete = true,
): void {
  let path = complete ? pathCache.get(stroke) : undefined;
  if (!path) {
    path = outlinePath(inkOutline(stroke, complete));
    if (complete) pathCache.set(stroke, path);
  }
  context.globalAlpha = Math.max(0, Math.min(1, stroke.opacity));
  context.globalCompositeOperation = stroke.tool === 'highlighter' ? 'multiply' : 'source-over';
  context.fillStyle = stroke.color;
  context.fill(path);
  context.globalAlpha = 1;
  context.globalCompositeOperation = 'source-over';
}
