/**
 * Reads the ZIP archive a user makes of a OneNote desktop export folder
 * (Windows Explorer "Send to > Compressed folder" or Compress-Archive). Only
 * what those tools write is supported: ZIP32 (archives up to 4 GB), stored or
 * deflated entries, no encryption. Inflation uses the platform's
 * DecompressionStream.
 *
 * `openZipArchive` reads only the central directory up front and inflates an
 * entry when it is read, slicing the archive `Blob` (a picked `File` is read
 * from disk on demand), so memory stays bounded by the largest entry.
 */
export interface ZipReadLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_ZIP_READ_LIMITS: ZipReadLimits = Object.freeze({
  maxEntries: 200_000,
  maxEntryBytes: 256 * 1024 * 1024,
  maxTotalBytes: 4 * 1024 * 1024 * 1024,
});

export interface ZipArchive {
  /** Entry names with forward slashes, directories excluded. */
  names(): string[];
  /** Uncompressed size, or undefined for a name the archive does not contain. */
  size(name: string): number | undefined;
  read(name: string): Promise<Uint8Array>;
}

interface ZipEntry {
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
const cp437Fallback = new TextDecoder('latin1');
const END_OF_DIRECTORY_SEARCH = 65_557;

async function inflateRaw(bytes: Uint8Array, expectedSize: number): Promise<Uint8Array> {
  const stream = new Blob([Uint8Array.from(bytes)]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const inflated = new Uint8Array(await new Response(stream).arrayBuffer());
  if (inflated.byteLength !== expectedSize) throw new Error('A ZIP entry inflated to an unexpected size.');
  return inflated;
}

function entryName(bytes: Uint8Array, flags: number): string {
  // Bit 11 marks UTF-8 names. Windows' built-in ZIP tools write UTF-8 without
  // always setting it, so UTF-8 is tried first either way.
  try {
    return utf8.decode(bytes);
  } catch {
    if (flags & 0x800) throw new Error('A ZIP entry name is not valid UTF-8.');
    return cp437Fallback.decode(bytes);
  }
}

async function sliceBytes(archive: Blob, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await archive.slice(start, end).arrayBuffer());
}

export async function openZipArchive(
  archive: Blob,
  limits: ZipReadLimits = DEFAULT_ZIP_READ_LIMITS,
): Promise<ZipArchive> {
  const tailStart = Math.max(0, archive.size - END_OF_DIRECTORY_SEARCH);
  const tail = await sliceBytes(archive, tailStart, archive.size);
  const tailView = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let end = -1;
  for (let offset = tail.byteLength - 22; offset >= 0; offset -= 1) {
    if (tailView.getUint32(offset, true) === 0x06054b50) {
      end = offset;
      break;
    }
  }
  if (end === -1) throw new Error('The file is not a ZIP archive.');
  const count = tailView.getUint16(end + 10, true);
  const directorySize = tailView.getUint32(end + 12, true);
  const directoryOffset = tailView.getUint32(end + 16, true);
  if (count === 0xffff || directoryOffset === 0xffffffff) throw new Error('ZIP64 archives are not supported.');
  if (count > limits.maxEntries) throw new Error('The ZIP archive has too many entries.');
  if (directoryOffset + directorySize > tailStart + end) throw new Error('The ZIP central directory is malformed.');
  const directory = await sliceBytes(archive, directoryOffset, directoryOffset + directorySize);
  const view = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);
  const entries = new Map<string, ZipEntry>();
  let cursor = 0;
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > directory.byteLength || view.getUint32(cursor, true) !== 0x02014b50) {
      throw new Error('The ZIP central directory is malformed.');
    }
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = entryName(directory.subarray(cursor + 46, cursor + 46 + nameLength), flags).replace(/\\/g, '/');
    cursor += 46 + nameLength + extraLength + commentLength;
    if (name.endsWith('/')) continue;
    if (flags & 0x1) throw new Error('Encrypted ZIP entries are not supported.');
    if (name.startsWith('/') || name.split('/').some((part) => part === '..')) {
      throw new Error(`The ZIP entry ${name} has an unsafe path.`);
    }
    if (size > limits.maxEntryBytes) throw new Error(`The ZIP entry ${name} is too large.`);
    total += size;
    if (total > limits.maxTotalBytes) throw new Error('The ZIP archive is too large to import.');
    if (method !== 0 && method !== 8) {
      throw new Error(`The ZIP entry ${name} uses unsupported compression method ${method}.`);
    }
    if (method === 0 && compressedSize !== size) throw new Error(`The stored ZIP entry ${name} has inconsistent sizes.`);
    if (entries.has(name)) throw new Error(`The ZIP archive contains ${name} twice.`);
    entries.set(name, { method, compressedSize, size, localOffset });
  }

  return {
    names: () => [...entries.keys()],
    size: (name) => entries.get(name)?.size,
    read: async (name) => {
      const entry = entries.get(name);
      if (!entry) throw new Error(`${name} is missing from the ZIP archive.`);
      const header = await sliceBytes(archive, entry.localOffset, entry.localOffset + 30);
      const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);
      if (header.byteLength !== 30 || headerView.getUint32(0, true) !== 0x04034b50) {
        throw new Error('A ZIP local header is malformed.');
      }
      const dataStart = entry.localOffset + 30 + headerView.getUint16(26, true) + headerView.getUint16(28, true);
      const data = await sliceBytes(archive, dataStart, dataStart + entry.compressedSize);
      if (data.byteLength !== entry.compressedSize) throw new Error(`The ZIP entry ${name} is truncated.`);
      return entry.method === 0 ? data : inflateRaw(data, entry.size);
    },
  };
}

/** Reads every entry at once. Prefer `openZipArchive` for large archives. */
export async function readZipEntries(
  source: Uint8Array,
  limits: ZipReadLimits = DEFAULT_ZIP_READ_LIMITS,
): Promise<Map<string, Uint8Array>> {
  const archive = await openZipArchive(new Blob([Uint8Array.from(source)]), limits);
  const entries = new Map<string, Uint8Array>();
  for (const name of archive.names()) entries.set(name, await archive.read(name));
  return entries;
}
