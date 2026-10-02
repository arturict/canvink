import { getStroke } from 'perfect-freehand';

/**
 * The geometry of a pen stroke, from the samples the digitizer sent to the
 * outline that is filled on screen and in exports.
 *
 * perfect-freehand's own streamlining pulls every point 17% towards its
 * predecessor, which lags behind fast handwriting, rounds off corners and
 * replaces the first `size` pixels of every stroke with a chord. A pen's
 * samples are clean, so the path here goes through every one of them
 * (centripetal Catmull-Rom: no overshoot, no loops, corners stay where the
 * pen turned) and is cut into steps of about a pixel. perfect-freehand then
 * only builds the pressure-shaped outline around that dense path.
 */
export interface PathPoint {
  x: number;
  y: number;
  /** Shaped pressure in 0..1, what the outline width is derived from. */
  pressure: number;
}

export type OutlinePoint = [number, number];

/** Samples closer together than this (page units) are the same sample. */
const SAME_POINT = 0.05;
/** Chords shorter than this on both sides of a sample are digitizer jitter, not handwriting. */
const JITTER_CHORD = 1.2;
const JITTER_BLEND = 0.3;
const MIN_DISTANCE_ROOT = 1e-3;

/** Distance between the steps of the dense path, which follows the line width. */
export function pathSpacing(size: number): number {
  return Math.min(1.2, Math.max(0.35, size * 0.3));
}

/**
 * A pen reports pressure 0 for the first sample or two of a stroke on some
 * digitizers. That is a contact, so the width comes from the first real
 * pressure that follows; a pen that never reports one is drawn at half.
 */
export function contactPressures(raw: readonly number[]): number[] {
  const positive = (value: number) => Number.isFinite(value) && value > 0.001;
  const firstPositive = raw.find(positive);
  const fallback = firstPositive ?? 0.5;
  let carried = fallback;
  return raw.map((value) => {
    if (positive(value)) {
      carried = value;
      return value;
    }
    return carried;
  });
}

/** Collapses duplicate samples and calms jitter, keeping the first and the last sample. */
function cleanSamples(samples: readonly PathPoint[]): PathPoint[] {
  const distinct: PathPoint[] = [];
  for (const sample of samples) {
    const previous = distinct[distinct.length - 1];
    if (previous && Math.hypot(sample.x - previous.x, sample.y - previous.y) < SAME_POINT) {
      // Keep the sample that is later in time, so the stroke still ends where the pen did.
      distinct[distinct.length - 1] = { ...sample };
      continue;
    }
    distinct.push({ ...sample });
  }
  if (distinct.length < 3) return distinct;
  const calmed = distinct.map((point) => ({ ...point }));
  for (let index = 1; index < distinct.length - 1; index += 1) {
    const before = distinct[index - 1];
    const point = distinct[index];
    const after = distinct[index + 1];
    if (
      Math.hypot(point.x - before.x, point.y - before.y) < JITTER_CHORD
      && Math.hypot(after.x - point.x, after.y - point.y) < JITTER_CHORD
    ) {
      calmed[index].x = point.x + JITTER_BLEND * ((before.x + after.x) / 2 - point.x);
      calmed[index].y = point.y + JITTER_BLEND * ((before.y + after.y) / 2 - point.y);
    }
  }
  return calmed;
}

function rootDistance(a: PathPoint, b: PathPoint): number {
  return Math.max(MIN_DISTANCE_ROOT, Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y)));
}

/**
 * Appends the dense points of the curve from `p1` to `p2` (the end included,
 * the start not) to `out`. `p0` and `p3` shape the tangents; where the stroke
 * has no neighbour they are the mirror image of the other side.
 */
export function catmullSegment(
  p0: PathPoint | undefined,
  p1: PathPoint,
  p2: PathPoint,
  p3: PathPoint | undefined,
  spacing: number,
  out: PathPoint[],
): void {
  const chord = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const steps = Math.max(1, Math.ceil(chord / spacing));
  const a = p0 ?? { x: 2 * p1.x - p2.x, y: 2 * p1.y - p2.y, pressure: p1.pressure };
  const d = p3 ?? { x: 2 * p2.x - p1.x, y: 2 * p2.y - p1.y, pressure: p2.pressure };
  const t0 = 0;
  const t1 = t0 + rootDistance(a, p1);
  const t2 = t1 + rootDistance(p1, p2);
  const t3 = t2 + rootDistance(p2, d);
  for (let step = 1; step <= steps; step += 1) {
    const u = step / steps;
    if (step === steps) {
      out.push({ x: p2.x, y: p2.y, pressure: p2.pressure });
      continue;
    }
    const t = t1 + (t2 - t1) * u;
    const lerp = (from: number, to: number, start: number, end: number) =>
      ((end - t) / (end - start)) * from + ((t - start) / (end - start)) * to;
    const point = (axis: 'x' | 'y') => {
      const a1 = lerp(a[axis], p1[axis], t0, t1);
      const a2 = lerp(p1[axis], p2[axis], t1, t2);
      const a3 = lerp(p2[axis], d[axis], t2, t3);
      const b1 = lerp(a1, a2, t0, t2);
      const b2 = lerp(a2, a3, t1, t3);
      return lerp(b1, b2, t1, t2);
    };
    out.push({
      x: point('x'),
      y: point('y'),
      pressure: p1.pressure + (p2.pressure - p1.pressure) * u,
    });
  }
}

/** A turn sharper than this at a sample is a corner of the writing, not part of a curve. */
const CORNER_COS = Math.cos((80 * Math.PI) / 180);
/**
 * A long flick into a short step turns less than that and still overshoots
 * the turn with a curve, so a clear turn between very unequal chords is a
 * corner as well.
 */
const UNEQUAL_CORNER_COS = Math.cos((45 * Math.PI) / 180);
const UNEQUAL_CHORDS = 3;
/** Shorter chords turn this sharply for no reason but noise. */
const CORNER_MIN_CHORD = 2;

function isCorner(before: PathPoint, point: PathPoint, after: PathPoint): boolean {
  const ax = point.x - before.x;
  const ay = point.y - before.y;
  const bx = after.x - point.x;
  const by = after.y - point.y;
  const first = Math.hypot(ax, ay);
  const second = Math.hypot(bx, by);
  if (first < CORNER_MIN_CHORD || second < CORNER_MIN_CHORD) return false;
  const cosine = (ax * bx + ay * by) / (first * second);
  if (cosine < CORNER_COS) return true;
  return cosine < UNEQUAL_CORNER_COS && Math.max(first, second) / Math.min(first, second) > UNEQUAL_CHORDS;
}

/**
 * Appends the dense points of the segment from `points[index]` to
 * `points[index + 1]`. A curve through a corner would overshoot it, so at a
 * corner the tangent follows the chord on each side and the turn stays sharp.
 */
export function appendSegment(
  points: readonly PathPoint[],
  index: number,
  spacing: number,
  out: PathPoint[],
): void {
  const p1 = points[index];
  const p2 = points[index + 1];
  const before = points[index - 1];
  const after = points[index + 2];
  catmullSegment(
    before && !isCorner(before, p1, p2) ? before : undefined,
    p1,
    p2,
    after && !isCorner(p1, p2, after) ? after : undefined,
    spacing,
    out,
  );
}

/** The dense path through all samples of a stroke; the first sample starts it. */
export function smoothCenterline(samples: readonly PathPoint[], spacing: number): PathPoint[] {
  const points = cleanSamples(samples);
  if (points.length === 0) return [];
  const path: PathPoint[] = [{ ...points[0] }];
  for (let index = 0; index + 1 < points.length; index += 1) appendSegment(points, index, spacing, path);
  return path;
}

/** The samples as `smoothCenterline` reads them: duplicates merged, jitter calmed. */
export function cleanedSamples(samples: readonly PathPoint[]): PathPoint[] {
  return cleanSamples(samples);
}

/** Page distance the samples cover, measured along the sample polyline. */
export function samplePathLength(samples: readonly PathPoint[]): number {
  let length = 0;
  for (let index = 1; index < samples.length; index += 1) {
    length += Math.hypot(samples[index].x - samples[index - 1].x, samples[index].y - samples[index - 1].y);
  }
  return length;
}

export interface WidthShape {
  size: number;
  /** perfect-freehand's thinning: how strongly pressure changes the width. */
  thinning: number;
}

/** Radius of the line at a pressure: the same rule perfect-freehand applies to its outline. */
export function radiusForPressure({ size, thinning }: WidthShape, pressure: number): number {
  return Math.max(0.01, size * (0.5 - thinning * (0.5 - pressure)));
}

const DOT_VERTICES = 24;

function dotOutline(centre: PathPoint, radius: number): OutlinePoint[] {
  return Array.from({ length: DOT_VERTICES }, (_, index) => {
    const angle = (index / DOT_VERTICES) * Math.PI * 2;
    return [centre.x + Math.cos(angle) * radius, centre.y + Math.sin(angle) * radius] as OutlinePoint;
  });
}

/**
 * The closed outline of a pen stroke, to be filled with quadratic midpoints.
 * A tap, where the pen barely moved, is a plain dot of the line's width.
 */
export function penOutline(samples: readonly PathPoint[], shape: WidthShape): OutlinePoint[] {
  if (samples.length === 0) return [];
  const spacing = pathSpacing(shape.size);
  if (samplePathLength(samples) < shape.size * 0.3) {
    const pressure = samples.reduce((sum, sample) => sum + sample.pressure, 0) / samples.length;
    return dotOutline(samples[0], radiusForPressure(shape, pressure));
  }
  const path = smoothCenterline(samples, spacing);
  return getStroke(
    path.map((point) => [point.x, point.y, point.pressure]),
    {
      size: shape.size,
      thinning: shape.thinning,
      // Outline vertices closer than about a pixel add nothing to the shape.
      smoothing: Math.min(0.6, Math.max(0.2, 1 / shape.size)),
      streamline: 0,
      easing: (value) => value,
      simulatePressure: false,
      start: { cap: true, taper: 0 },
      end: { cap: true, taper: 0 },
      last: true,
    },
  ) as OutlinePoint[];
}
