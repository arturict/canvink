/**
 * Pure rules for an active stylus (Windows Ink delivers it as pointer events
 * with `pointerType: "pen"`): pressure and tilt shaping. What the pen's
 * buttons do lives in `penButtons.ts`.
 */

/** Lowest pressure that still leaves a visible line; the pen must never write a hairline gap. */
const PRESSURE_FLOOR = 0.06;
/** Below 1 lifts light writing pressure towards the nominal width. */
const PRESSURE_GAMMA = 0.8;

/**
 * Raw pen pressure to the value the stroke outline is built from. Light
 * pressure stays thin but never vanishes (no gap where a stroke starts), and
 * full pressure reaches 1 without going past it (no blobs).
 */
export function naturalPressure(raw: number): number {
  if (!Number.isFinite(raw)) return 0.5;
  const clamped = Math.min(1, Math.max(0, raw));
  return PRESSURE_FLOOR + (1 - PRESSURE_FLOOR) * clamped ** PRESSURE_GAMMA;
}

/**
 * One 1-2-1 smoothing pass over a stroke's pressures. It removes the
 * sample-to-sample jitter that draws beads into a line, and the end samples
 * keep their weight so a stroke still starts and ends where the pen did.
 */
export function smoothPressures(values: readonly number[]): number[] {
  if (values.length < 3) return [...values];
  return values.map((value, index) => {
    const before = values[Math.max(0, index - 1)];
    const after = values[Math.min(values.length - 1, index + 1)];
    return (before + 2 * value + after) / 4;
  });
}

/**
 * Highlighter width from pen tilt, as a pressure-like value: 0.5 for an
 * upright pen (the nominal width), up to 1 for a pen lying flat, like the
 * broad side of a chisel tip. Pens without tilt report 0 and stay nominal.
 */
export function tiltPressure(tiltX: number, tiltY: number): number {
  const magnitude = Math.min(90, Math.hypot(Number.isFinite(tiltX) ? tiltX : 0, Number.isFinite(tiltY) ? tiltY : 0));
  return 0.5 + 0.5 * (magnitude / 90);
}
