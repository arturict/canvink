import type { StrokeElementV2 } from '../domain/v2';
import { ByteReader, ByteWriter, POSITION_STEPS, packStrokePoints, unpackStrokePoints } from '../crdt/packedStrokePoints';

/**
 * The binary form of an ink segment: many strokes in one immutable blob that
 * is stored and synced like an asset, addressed by the SHA-256 of its bytes.
 *
 * Layout (integers are LEB128 varints, signed ones zig-zag):
 *
 *   3 bytes  magic "CIS", 1 byte version
 *   varint   stroke count
 *   varint   id prefix count, then per prefix: varint length, UTF-8 bytes
 *   varint   style count, then per style: varint length, UTF-8 JSON of every
 *            stroke field that is not listed below (tool, colour, size,
 *            opacity, locked and anything a later build adds), keys sorted
 *   per stroke, in draw order:
 *     byte     id kind: 0 text (varint length, UTF-8), 1 "<prefix>-<uuid>"
 *              (varint prefix index, 16 raw bytes)
 *     varint   style index
 *     byte     flags: 1 updatedAt differs from createdAt, 2 tombstonedAt,
 *              4 sourceStrokeId
 *     time     createdAt, then updatedAt when it differs (see below)
 *     4 x num  frame x, y, width, height
 *     rotation byte 0 (zero) or byte 1 and a float64
 *     varint   length of the packed samples, then `packStrokePoints` bytes
 *     [text]   tombstonedAt, sourceStrokeId (varint length, UTF-8) when flagged
 *
 * time: byte 0 then a signed varint millisecond delta from the previous time
 * of the segment for canonical ISO strings, byte 1 then text for any other.
 * num: a varint holding the value rounded to 1/128 unit (zig-zag, times two),
 * or the varint 1 followed by the 8 bytes of a float64 for values that do not fit.
 *
 * Positions and the frame's box are held at 1/128 unit, the precision the packed
 * samples already have; `quantizeStroke` applies that to a stroke, and
 * quantising twice changes nothing, so writes do not drift.
 */
export const INK_SEGMENT_VERSION = 1;
const MAGIC = [0x43, 0x49, 0x53] as const;
const ID_TEXT = 0;
const ID_UUID = 1;
const FLAG_UPDATED = 1;
const FLAG_TOMBSTONED = 2;
const FLAG_SOURCE = 4;
const MAX_QUANTIZED = 2 ** 39;
const MAX_STROKES = 200_000;
const MAX_TEXT_BYTES = 1 << 20;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const UUID_ID = /^(.*)-([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/;
const CANONICAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Fields the fixed record layout carries; everything else goes into the style table. */
const RECORD_KEYS = new Set([
  'id', 'kind', 'frame', 'createdAt', 'updatedAt', 'points', 'tombstonedAt', 'sourceStrokeId',
]);

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(record).sort()) {
    if (record[key] !== undefined) parts.push(`${JSON.stringify(key)}:${stableJson(record[key])}`);
  }
  return `{${parts.join(',')}}`;
}

function writeText(writer: ByteWriter, text: string): void {
  const bytes = encoder.encode(text);
  writer.varint(bytes.length);
  writer.raw(bytes);
}

function readText(reader: ByteReader): string {
  const length = reader.varint();
  if (length > MAX_TEXT_BYTES) throw new RangeError('Ink segment text is too long.');
  return decoder.decode(reader.raw(length));
}

function writeNumber(writer: ByteWriter, value: number): void {
  const scaled = Math.round(value * POSITION_STEPS);
  if (!Number.isFinite(value) || Math.abs(scaled) >= MAX_QUANTIZED) {
    writer.varint(1);
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value, true);
    writer.raw(new Uint8Array(view.buffer));
    return;
  }
  writer.varint((scaled >= 0 ? scaled * 2 : -scaled * 2 - 1) * 2);
}

/** Rotation is an angle in radians and stays exact: one byte for zero, else a float64. */
function writeRotation(writer: ByteWriter, rotation: number): void {
  if (rotation === 0) {
    writer.byte(0);
    return;
  }
  writer.byte(1);
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, rotation, true);
  writer.raw(new Uint8Array(view.buffer));
}

function readRotation(reader: ByteReader): number {
  const kind = reader.byte();
  if (kind === 0) return 0;
  if (kind !== 1) throw new RangeError('Ink segment rotation has an unknown form.');
  const bytes = reader.raw(8);
  return new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, true);
}

function readNumber(reader: ByteReader): number {
  const tag = reader.varint();
  if (tag === 1) {
    const bytes = reader.raw(8);
    return new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, true);
  }
  if (tag % 2 !== 0) throw new RangeError('Ink segment number has an unknown form.');
  const zigzag = tag / 2;
  const scaled = zigzag % 2 === 0 ? zigzag / 2 : -(zigzag + 1) / 2;
  return scaled / POSITION_STEPS;
}

/** A frame value at the segment's precision; values it cannot hold stay as they are. */
function quantizeNumber(value: number): number {
  if (!Number.isFinite(value)) return value;
  const scaled = Math.round(value * POSITION_STEPS);
  return Math.abs(scaled) < MAX_QUANTIZED ? scaled / POSITION_STEPS : value;
}

/**
 * The stroke as an ink segment holds it: frame at 1/128 unit, samples at the
 * packed precision. Returns the stroke itself when its samples cannot be
 * packed (the caller then keeps it out of segments).
 */
export function quantizeStroke<T extends StrokeElementV2>(stroke: T): T {
  const packed = packStrokePoints(stroke.points);
  if (!packed) return stroke;
  return { ...stroke, points: unpackStrokePoints(packed), frame: quantizeFrame(stroke.frame) };
}

/** The frame with its box at 1/128 unit; the rotation, an angle, stays exact. */
export function quantizeFrame<T extends StrokeElementV2['frame']>(frame: T): T {
  return {
    ...frame,
    x: quantizeNumber(frame.x),
    y: quantizeNumber(frame.y),
    width: quantizeNumber(frame.width),
    height: quantizeNumber(frame.height),
  };
}

/** Whether a stroke can be held by a segment without losing more than the stated precision. */
export function isSegmentStroke(stroke: StrokeElementV2): boolean {
  return packStrokePoints(stroke.points) !== null
    && [stroke.frame.x, stroke.frame.y, stroke.frame.width, stroke.frame.height, stroke.frame.rotation]
      .every(Number.isFinite);
}

function isoMilliseconds(value: string): number | undefined {
  if (!CANONICAL_TIME.test(value)) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value ? milliseconds : undefined;
}

class TimeWriter {
  private previous = 0;

  write(writer: ByteWriter, value: string): void {
    const milliseconds = isoMilliseconds(value);
    if (milliseconds === undefined) {
      writer.byte(1);
      writeText(writer, value);
      return;
    }
    writer.byte(0);
    writer.signed(milliseconds - this.previous);
    this.previous = milliseconds;
  }
}

class TimeReader {
  private previous = 0;

  read(reader: ByteReader): string {
    const kind = reader.byte();
    if (kind === 1) return readText(reader);
    if (kind !== 0) throw new RangeError('Ink segment time has an unknown form.');
    this.previous += reader.signed();
    return new Date(this.previous).toISOString();
  }
}

function hexByte(value: string, offset: number): number {
  return Number.parseInt(value.slice(offset, offset + 2), 16);
}

function uuidBytes(parts: readonly string[]): Uint8Array {
  const hex = parts.join('');
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1) bytes[index] = hexByte(hex, index * 2);
  return bytes;
}

function uuidText(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Encodes strokes into one segment. Every stroke must satisfy
 * `isSegmentStroke`; the encoder does not quantise silently, so decoding
 * returns `quantizeStroke(stroke)` for each input.
 */
export function encodeInkSegment(strokes: readonly StrokeElementV2[]): Uint8Array {
  if (strokes.length > MAX_STROKES) throw new RangeError('Too many strokes for one ink segment.');
  const prefixes: string[] = [];
  const prefixIndex = new Map<string, number>();
  const styles: string[] = [];
  const styleIndex = new Map<string, number>();
  const styleOf: number[] = [];
  const idParts: Array<{ prefix: number; uuid: Uint8Array } | undefined> = [];
  for (const stroke of strokes) {
    const match = UUID_ID.exec(stroke.id);
    if (match) {
      let index = prefixIndex.get(match[1]);
      if (index === undefined) {
        index = prefixes.length;
        prefixes.push(match[1]);
        prefixIndex.set(match[1], index);
      }
      idParts.push({ prefix: index, uuid: uuidBytes(match.slice(2)) });
    } else idParts.push(undefined);
    const rest: Record<string, unknown> = {};
    for (const key of Object.keys(stroke)) {
      if (!RECORD_KEYS.has(key)) rest[key] = (stroke as unknown as Record<string, unknown>)[key];
    }
    const json = stableJson(rest);
    let style = styleIndex.get(json);
    if (style === undefined) {
      style = styles.length;
      styles.push(json);
      styleIndex.set(json, style);
    }
    styleOf.push(style);
  }

  const writer = new ByteWriter();
  for (const byte of MAGIC) writer.byte(byte);
  writer.byte(INK_SEGMENT_VERSION);
  writer.varint(strokes.length);
  writer.varint(prefixes.length);
  for (const prefix of prefixes) writeText(writer, prefix);
  writer.varint(styles.length);
  for (const style of styles) writeText(writer, style);

  const times = new TimeWriter();
  strokes.forEach((stroke, index) => {
    const parts = idParts[index];
    if (parts) {
      writer.byte(ID_UUID);
      writer.varint(parts.prefix);
      writer.raw(parts.uuid);
    } else {
      writer.byte(ID_TEXT);
      writeText(writer, stroke.id);
    }
    writer.varint(styleOf[index]);
    const differs = stroke.updatedAt !== stroke.createdAt;
    writer.byte(
      (differs ? FLAG_UPDATED : 0)
      | (stroke.tombstonedAt !== undefined ? FLAG_TOMBSTONED : 0)
      | (stroke.sourceStrokeId !== undefined ? FLAG_SOURCE : 0),
    );
    times.write(writer, stroke.createdAt);
    if (differs) times.write(writer, stroke.updatedAt);
    writeNumber(writer, stroke.frame.x);
    writeNumber(writer, stroke.frame.y);
    writeNumber(writer, stroke.frame.width);
    writeNumber(writer, stroke.frame.height);
    writeRotation(writer, stroke.frame.rotation);
    const packed = packStrokePoints(stroke.points);
    if (!packed) throw new RangeError(`Stroke ${stroke.id} cannot be held by an ink segment.`);
    writer.varint(packed.length);
    writer.raw(packed);
    if (stroke.tombstonedAt !== undefined) writeText(writer, stroke.tombstonedAt);
    if (stroke.sourceStrokeId !== undefined) writeText(writer, stroke.sourceStrokeId);
  });
  return writer.finish();
}

/**
 * Decodes a segment into frozen stroke elements with frozen sample lists, the
 * shared, immutable form snapshots hand to the editor. Throws a RangeError
 * on malformed bytes.
 */
export function decodeInkSegment(bytes: Uint8Array): StrokeElementV2[] {
  const reader = new ByteReader(bytes);
  for (const expected of MAGIC) {
    if (reader.byte() !== expected) throw new RangeError('Not an ink segment.');
  }
  const version = reader.byte();
  if (version !== INK_SEGMENT_VERSION) throw new RangeError(`Unsupported ink segment version ${version}.`);
  const count = reader.varint();
  if (count > MAX_STROKES) throw new RangeError('Ink segment has too many strokes.');
  const prefixes: string[] = [];
  for (let index = reader.varint(); index > 0; index -= 1) prefixes.push(readText(reader));
  const styles: Array<Record<string, unknown>> = [];
  for (let index = reader.varint(); index > 0; index -= 1) {
    const parsed: unknown = JSON.parse(readText(reader));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new RangeError('Ink segment style is not an object.');
    }
    styles.push(parsed as Record<string, unknown>);
  }

  const times = new TimeReader();
  const strokes = new Array<StrokeElementV2>(count);
  for (let index = 0; index < count; index += 1) {
    const idKind = reader.byte();
    let id: string;
    if (idKind === ID_UUID) {
      const prefix = prefixes[reader.varint()];
      if (prefix === undefined) throw new RangeError('Ink segment id prefix is missing.');
      id = `${prefix}-${uuidText(reader.raw(16))}`;
    } else if (idKind === ID_TEXT) id = readText(reader);
    else throw new RangeError('Ink segment id has an unknown form.');
    const style = styles[reader.varint()];
    if (!style) throw new RangeError('Ink segment style is missing.');
    const flags = reader.byte();
    const createdAt = times.read(reader);
    const updatedAt = (flags & FLAG_UPDATED) !== 0 ? times.read(reader) : createdAt;
    const frame = Object.freeze({
      x: readNumber(reader),
      y: readNumber(reader),
      width: readNumber(reader),
      height: readNumber(reader),
      rotation: readRotation(reader),
    });
    const points = unpackStrokePoints(reader.raw(reader.varint()));
    for (const point of points) Object.freeze(point);
    Object.freeze(points);
    const stroke: Record<string, unknown> = { ...style, id, kind: 'stroke', frame, createdAt, updatedAt, points };
    if ((flags & FLAG_TOMBSTONED) !== 0) stroke.tombstonedAt = readText(reader);
    if ((flags & FLAG_SOURCE) !== 0) stroke.sourceStrokeId = readText(reader);
    strokes[index] = Object.freeze(stroke) as unknown as StrokeElementV2;
  }
  if (!reader.done) throw new RangeError('Ink segment has trailing bytes.');
  return strokes;
}
