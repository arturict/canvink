import type { StrokePointV2 } from '../domain/v2';

/**
 * The packed form of one stroke's sample list: a single byte string instead
 * of one Automerge map (with seven fields) per sample.
 *
 * Layout, all integers LEB128 varints (zig-zag for signed values):
 *
 *   byte   version (1)
 *   byte   flags: 1 pressure varies, 2 tilt present, 4 time present
 *   byte   pointer type: 0 pen, 1 mouse, 2 touch, 3 custom (varint length and
 *          UTF-8 bytes follow)
 *   varint sample count
 *   x0 y0, then (dx dy) per further sample, in units of 1/POSITION_STEPS
 *   pressure: one byte per sample when it varies, else one byte for all
 *   tilt: two signed bytes (tiltX, tiltY in whole degrees) per sample
 *   time: first sample in whole milliseconds, then one delta per sample
 *
 * The format is lossy by design and states its precision: positions to
 * 1/128 unit, pressure to 1/254, tilt to one degree, time to one
 * millisecond. Decoding what was encoded returns exactly the same samples
 * again, so a stroke that is packed twice does not drift.
 */
export const PACKED_STROKE_VERSION = 1;
export const POSITION_STEPS = 128;
/** 254 steps make 0, 0.5 and 1 exact, the values mice and touch report. */
export const PRESSURE_STEPS = 254;

const FLAG_PRESSURE_VARIES = 1;
const FLAG_TILT = 2;
const FLAG_TIME = 4;
const KNOWN_FLAGS = FLAG_PRESSURE_VARIES | FLAG_TILT | FLAG_TIME;

const POINTER_TYPES = ['pen', 'mouse', 'touch'] as const;
const CUSTOM_POINTER_TYPE = POINTER_TYPES.length;
const MAX_CUSTOM_POINTER_TYPE_BYTES = 64;
/** Far beyond any page (coordinates are limited to a few hundred thousand). */
const MAX_POSITION = 2 ** 40 / POSITION_STEPS;
const MAX_TIME_MS = 2 ** 50;
const MAX_TILT = 127;
const MAX_SAMPLES = 1_000_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export class ByteWriter {
  private bytes = new Uint8Array(256);
  length = 0;

  private ensure(extra: number): void {
    if (this.length + extra <= this.bytes.length) return;
    let capacity = this.bytes.length;
    while (capacity < this.length + extra) capacity *= 2;
    const grown = new Uint8Array(capacity);
    grown.set(this.bytes.subarray(0, this.length));
    this.bytes = grown;
  }

  byte(value: number): void {
    this.ensure(1);
    this.bytes[this.length] = value;
    this.length += 1;
  }

  raw(bytes: Uint8Array): void {
    this.ensure(bytes.length);
    this.bytes.set(bytes, this.length);
    this.length += bytes.length;
  }

  /** Unsigned LEB128 over doubles, so values above 2^32 need no BigInt. */
  varint(value: number): void {
    let rest = value;
    while (rest >= 0x80) {
      this.byte((rest % 0x80) | 0x80);
      rest = Math.floor(rest / 0x80);
    }
    this.byte(rest);
  }

  signed(value: number): void {
    this.varint(value >= 0 ? value * 2 : -value * 2 - 1);
  }

  finish(): Uint8Array {
    return this.bytes.slice(0, this.length);
  }
}

export class ByteReader {
  offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  byte(): number {
    if (this.offset >= this.bytes.length) throw new RangeError('Packed stroke is truncated.');
    const value = this.bytes[this.offset];
    this.offset += 1;
    return value;
  }

  raw(length: number): Uint8Array {
    if (this.offset + length > this.bytes.length) throw new RangeError('Packed stroke is truncated.');
    const value = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  varint(): number {
    let value = 0;
    let scale = 1;
    for (let shift = 0; shift < 8; shift += 1) {
      const next = this.byte();
      value += (next & 0x7f) * scale;
      if (next < 0x80) return value;
      scale *= 0x80;
    }
    throw new RangeError('Packed stroke has an oversized number.');
  }

  signed(): number {
    const value = this.varint();
    return value % 2 === 0 ? value / 2 : -(value + 1) / 2;
  }

  get done(): boolean {
    return this.offset === this.bytes.length;
  }
}

function pointerTypeCode(pointerType: string): number {
  const index = (POINTER_TYPES as readonly string[]).indexOf(pointerType);
  return index >= 0 ? index : CUSTOM_POINTER_TYPE;
}

/**
 * Packs the samples of one stroke. Returns `null` when the samples cannot be
 * represented without changing more than the documented precision (a value
 * outside the supported range, mixed pointer types); callers then store the
 * samples in their plain form.
 */
export function packStrokePoints(points: readonly StrokePointV2[]): Uint8Array | null {
  if (points.length > MAX_SAMPLES) return null;
  const first = points[0];
  const pointerType = first?.pointerType ?? 'pen';
  const positions = new Array<number>(points.length * 2);
  const pressures = new Array<number>(points.length);
  let pressureVaries = false;
  let hasTilt = false;
  let hasTime = false;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (point.pointerType !== pointerType) return null;
    if (
      !Number.isFinite(point.x) || !Number.isFinite(point.y)
      || Math.abs(point.x) > MAX_POSITION || Math.abs(point.y) > MAX_POSITION
      || !Number.isFinite(point.pressure) || point.pressure < 0 || point.pressure > 1
      || !Number.isFinite(point.tiltX) || !Number.isFinite(point.tiltY)
      || Math.abs(point.tiltX) > MAX_TILT || Math.abs(point.tiltY) > MAX_TILT
      || !Number.isFinite(point.time) || Math.abs(point.time) > MAX_TIME_MS
    ) return null;
    positions[index * 2] = Math.round(point.x * POSITION_STEPS);
    positions[index * 2 + 1] = Math.round(point.y * POSITION_STEPS);
    pressures[index] = Math.round(point.pressure * PRESSURE_STEPS);
    if (pressures[index] !== pressures[0]) pressureVaries = true;
    if (Math.round(point.tiltX) !== 0 || Math.round(point.tiltY) !== 0) hasTilt = true;
    if (Math.round(point.time) !== 0) hasTime = true;
  }

  const code = pointerTypeCode(pointerType);
  const custom = code === CUSTOM_POINTER_TYPE ? encoder.encode(pointerType) : undefined;
  if (custom && custom.length > MAX_CUSTOM_POINTER_TYPE_BYTES) return null;

  const writer = new ByteWriter();
  writer.byte(PACKED_STROKE_VERSION);
  writer.byte(
    (pressureVaries ? FLAG_PRESSURE_VARIES : 0) | (hasTilt ? FLAG_TILT : 0) | (hasTime ? FLAG_TIME : 0),
  );
  writer.byte(code);
  if (custom) {
    writer.varint(custom.length);
    writer.raw(custom);
  }
  writer.varint(points.length);
  for (let index = 0; index < points.length; index += 1) {
    const x = positions[index * 2];
    const y = positions[index * 2 + 1];
    if (index === 0) {
      writer.signed(x);
      writer.signed(y);
    } else {
      writer.signed(x - positions[index * 2 - 2]);
      writer.signed(y - positions[index * 2 - 1]);
    }
  }
  if (points.length > 0) {
    if (pressureVaries) for (const pressure of pressures) writer.byte(pressure);
    else writer.byte(pressures[0]);
  }
  if (hasTilt) {
    for (const point of points) {
      writer.byte(Math.round(point.tiltX) & 0xff);
      writer.byte(Math.round(point.tiltY) & 0xff);
    }
  }
  if (hasTime) {
    let previous = 0;
    for (const point of points) {
      const time = Math.round(point.time);
      writer.signed(time - previous);
      previous = time;
    }
  }
  return writer.finish();
}

/** Restores the samples of `packStrokePoints`. Throws on malformed bytes. */
export function unpackStrokePoints(bytes: Uint8Array): StrokePointV2[] {
  const reader = new ByteReader(bytes);
  const version = reader.byte();
  if (version !== PACKED_STROKE_VERSION) {
    throw new RangeError(`Unsupported packed stroke version ${version}.`);
  }
  const flags = reader.byte();
  if ((flags & ~KNOWN_FLAGS) !== 0) throw new RangeError('Packed stroke has unknown flags.');
  const code = reader.byte();
  let pointerType: string;
  if (code < CUSTOM_POINTER_TYPE) pointerType = POINTER_TYPES[code];
  else if (code === CUSTOM_POINTER_TYPE) {
    const length = reader.varint();
    if (length > MAX_CUSTOM_POINTER_TYPE_BYTES) throw new RangeError('Packed stroke pointer type is too long.');
    pointerType = decoder.decode(reader.raw(length));
  } else throw new RangeError('Packed stroke has an unknown pointer type.');

  const count = reader.varint();
  if (count > MAX_SAMPLES) throw new RangeError('Packed stroke has too many samples.');
  const xs = new Array<number>(count);
  const ys = new Array<number>(count);
  let x = 0;
  let y = 0;
  for (let index = 0; index < count; index += 1) {
    x += reader.signed();
    y += reader.signed();
    xs[index] = x / POSITION_STEPS;
    ys[index] = y / POSITION_STEPS;
  }
  const pressures = new Array<number>(count);
  if (count > 0) {
    if ((flags & FLAG_PRESSURE_VARIES) !== 0) {
      for (let index = 0; index < count; index += 1) pressures[index] = reader.byte() / PRESSURE_STEPS;
    } else pressures.fill(reader.byte() / PRESSURE_STEPS);
  }
  const tiltX = new Array<number>(count).fill(0);
  const tiltY = new Array<number>(count).fill(0);
  if ((flags & FLAG_TILT) !== 0) {
    for (let index = 0; index < count; index += 1) {
      tiltX[index] = (reader.byte() << 24) >> 24;
      tiltY[index] = (reader.byte() << 24) >> 24;
    }
  }
  const times = new Array<number>(count).fill(0);
  if ((flags & FLAG_TIME) !== 0) {
    let time = 0;
    for (let index = 0; index < count; index += 1) {
      time += reader.signed();
      times[index] = time;
    }
  }
  if (!reader.done) throw new RangeError('Packed stroke has trailing bytes.');

  const points = new Array<StrokePointV2>(count);
  for (let index = 0; index < count; index += 1) {
    points[index] = {
      x: xs[index],
      y: ys[index],
      pressure: pressures[index],
      tiltX: tiltX[index],
      tiltY: tiltY[index],
      time: times[index],
      pointerType,
    };
  }
  return points;
}
