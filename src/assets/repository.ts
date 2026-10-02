import {
  MAX_IMAGE_FILE_BYTES,
  MAX_IMAGE_PIXELS,
  MAX_PDF_FILE_BYTES,
  MAX_WORKSPACE_IMPORT_BYTES,
} from '../domain/limits';
import { sha256Bytes } from '../domain/v2/hash';
import type { AssetBlob, AssetRef, Sha256Checksum } from '../domain/v2';
import type {
  AssetReadOptions,
  AssetRepository,
  AttachmentAccess,
  OriginalAssetInput,
  StoredOriginalAsset,
} from './types';

const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;
const MAX_FILE_NAME_BYTES = 4_096;

export async function storeOriginalAsset(
  repository: AssetRepository,
  input: OriginalAssetInput,
): Promise<StoredOriginalAsset> {
  const mimeType = normalizeMimeType(input.mimeType);
  const fileName = normalizeFileName(input.fileName);
  const maximum =
    input.kind === 'pdf'
      ? MAX_PDF_FILE_BYTES
      : input.kind === 'image'
        ? MAX_IMAGE_FILE_BYTES
        : MAX_WORKSPACE_IMPORT_BYTES;
  if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0 || input.bytes.byteLength > maximum) {
    throw new Error(`${input.kind} asset exceeds its supported byte limit.`);
  }
  const bytes = input.bytes.slice();

  let imageDimensions: StoredOriginalAsset['imageDimensions'];
  if (input.kind === 'pdf') {
    if (mimeType !== 'application/pdf' || !hasPrefix(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
      throw new Error('PDF MIME type or magic bytes are invalid.');
    }
  } else if (input.kind === 'image') {
    imageDimensions = inspectImage(bytes, mimeType);
    if (imageDimensions.width * imageDimensions.height > MAX_IMAGE_PIXELS) {
      throw new Error('Image exceeds the decoded pixel limit.');
    }
  } else {
    assertKnownMagicDoesNotConflict(bytes, mimeType);
  }

  const assetId = await sha256Bytes(bytes);
  const existing = await repository.getAsset(assetId);
  if (existing) {
    await assertAssetIntegrity(existing, assetId);
    if (!equalBytes(existing.bytes, bytes)) {
      throw new Error('A different stored asset produced the same SHA-256 identifier.');
    }
  }
  const blob: AssetBlob = { assetId, checksum: assetId, size: bytes.byteLength, bytes };
  const disposition = existing ? 'deduplicated' : await repository.putAsset(blob);
  if (!existing && disposition === 'deduplicated') {
    const raced = await repository.getAsset(assetId);
    if (!raced) throw new Error('Asset repository reported deduplication without retaining the asset.');
    await assertAssetIntegrity(raced, assetId);
    if (!equalBytes(raced.bytes, bytes)) throw new Error('Deduplicated asset bytes do not match the original.');
  }
  const ref: AssetRef = {
    assetId,
    checksum: assetId,
    mimeType,
    size: bytes.byteLength,
    ...(fileName ? { fileName } : {}),
    role: 'original',
  };
  return { ref, disposition, ...(imageDimensions ? { imageDimensions } : {}) };
}

/**
 * The asset is not in local storage. On a device that synced the documents
 * first this is the normal state until the bytes arrive from the cloud, so
 * callers treat it as "not here yet", never as corruption or a save failure.
 */
export class AssetMissingError extends Error {
  constructor(readonly assetId: string) {
    super(`Asset ${assetId} is missing.`);
    this.name = 'AssetMissingError';
  }
}

export async function reopenAsset(
  repository: AssetRepository,
  ref: AssetRef,
): Promise<Uint8Array> {
  return copyBytes(await readAssetBytes(repository, ref));
}

/**
 * Like `reopenAsset` without the defensive copy, for callers that only read
 * the bytes (a display blob, a decoder) and would otherwise copy a multi-
 * megabyte image once more. The bytes may be the repository's own buffer:
 * never modify or retain them beyond the read.
 */
export async function readAssetBytes(
  repository: AssetRepository,
  ref: Pick<AssetRef, 'assetId' | 'checksum' | 'size'>,
  options?: AssetReadOptions,
): Promise<Uint8Array> {
  const asset = await repository.getAsset(ref.assetId, options);
  if (!asset) throw new AssetMissingError(ref.assetId);
  await assertAssetIntegrity(asset, ref.assetId);
  if (ref.checksum !== asset.checksum || ref.size !== asset.size) {
    throw new Error(`Asset reference ${ref.assetId} does not match stored bytes.`);
  }
  if (!(asset.bytes instanceof Uint8Array)) throw new Error('Asset bytes must be a Uint8Array.');
  return asset.bytes;
}

export async function accessAttachment(
  repository: AssetRepository,
  ref: AssetRef,
  disposition: 'open' | 'download',
): Promise<AttachmentAccess> {
  const bytes = await reopenAsset(repository, ref);
  return {
    fileName: ref.fileName ?? 'attachment',
    mimeType: ref.mimeType,
    size: bytes.byteLength,
    bytes,
    disposition,
  };
}

export async function ingestClipboardScreenshot(
  repository: AssetRepository,
  input: { bytes: Uint8Array; mimeType: string; fileName?: string },
): Promise<StoredOriginalAsset> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(input.mimeType.toLowerCase())) {
    throw new Error('Clipboard screenshots must be PNG, JPEG, or WebP.');
  }
  return storeOriginalAsset(repository, { ...input, kind: 'image' });
}

export class MemoryAssetRepository implements AssetRepository {
  private readonly assets = new Map<Sha256Checksum, AssetBlob>();

  async getAsset(assetId: Sha256Checksum): Promise<AssetBlob | undefined> {
    const asset = this.assets.get(assetId);
    return asset ? structuredClone(asset) : undefined;
  }

  async putAsset(asset: AssetBlob): Promise<'stored' | 'deduplicated'> {
    const existing = this.assets.get(asset.assetId);
    if (existing) return 'deduplicated';
    this.assets.set(asset.assetId, structuredClone(asset));
    return 'stored';
  }
}

async function assertAssetIntegrity(asset: AssetBlob, expected: Sha256Checksum): Promise<void> {
  if (
    asset.assetId !== expected ||
    asset.checksum !== expected ||
    asset.size !== asset.bytes.byteLength ||
    (await sha256Bytes(asset.bytes)) !== expected
  ) {
    throw new Error(`Stored asset ${expected} failed SHA-256 integrity verification.`);
  }
}

function inspectImage(bytes: Uint8Array, mimeType: string): { width: number; height: number } {
  let dimensions: { width: number; height: number } | undefined;
  if (mimeType === 'image/png' && hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    if (!hasCanonicalPngStructure(bytes)) {
      throw new Error('PNG is corrupt, truncated, or contains trailing data after its IEND chunk.');
    }
    dimensions = { width: readU32(bytes, 16), height: readU32(bytes, 20) };
  } else if (mimeType === 'image/gif' && bytes.length >= 10 && text(bytes, 0, 3) === 'GIF') {
    dimensions = { width: bytes[6] | (bytes[7] << 8), height: bytes[8] | (bytes[9] << 8) };
  } else if (mimeType === 'image/jpeg' && hasPrefix(bytes, [0xff, 0xd8])) {
    dimensions = jpegDimensions(bytes);
  } else if (mimeType === 'image/webp' && text(bytes, 0, 4) === 'RIFF' && text(bytes, 8, 4) === 'WEBP') {
    dimensions = webpDimensions(bytes);
  } else if (mimeType === 'image/bmp' && bytes.length >= 26 && text(bytes, 0, 2) === 'BM') {
    const headerSize = bytes[14] | (bytes[15] << 8) | (bytes[16] << 16) | (bytes[17] << 24);
    if (headerSize === 12) {
      // BITMAPCOREHEADER stores 16-bit unsigned dimensions.
      dimensions = { width: bytes[18] | (bytes[19] << 8), height: bytes[20] | (bytes[21] << 8) };
    } else {
      // BITMAPINFOHEADER and later store 32-bit signed dimensions; a negative
      // height marks a top-down bitmap, so take the magnitude.
      const width = bytes[18] | (bytes[19] << 8) | (bytes[20] << 16) | (bytes[21] << 24);
      const height = bytes[22] | (bytes[23] << 8) | (bytes[24] << 16) | (bytes[25] << 24);
      dimensions = { width, height: Math.abs(height) };
    }
  }
  if (!dimensions || dimensions.width < 1 || dimensions.height < 1) {
    throw new Error('Image MIME type, magic bytes, or dimensions are invalid.');
  }
  return dimensions;
}

function hasCanonicalPngStructure(bytes: Uint8Array): boolean {
  if (bytes.length < 33 || readU32(bytes, 8) !== 13 || text(bytes, 12, 4) !== 'IHDR') return false;
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const chunkLength = readU32(bytes, offset);
    const chunkEnd = offset + 12 + chunkLength;
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > bytes.length) return false;
    const expectedCrc = readU32(bytes, offset + 8 + chunkLength);
    if (crc32(bytes, offset + 4, offset + 8 + chunkLength) !== expectedCrc) return false;
    const chunkType = text(bytes, offset + 4, 4);
    if (chunkType === 'IEND') return chunkLength === 0 && chunkEnd === bytes.length;
    offset = chunkEnd;
  }
  return false;
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb8_8320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let value = 0xffff_ffff;
  for (let index = start; index < end; index += 1) {
    value = CRC_TABLE[(value ^ bytes[index]) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffff_ffff) >>> 0;
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > bytes.length) return undefined;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) return undefined;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return {
        height: (bytes[offset + 3] << 8) | bytes[offset + 4],
        width: (bytes[offset + 5] << 8) | bytes[offset + 6],
      };
    }
    offset += length;
  }
  return undefined;
}

function webpDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 20 || readU32LE(bytes, 4) + 8 > bytes.length) return undefined;
  const kind = text(bytes, 12, 4);
  if (kind === 'VP8X' && bytes.length >= 30) {
    return { width: 1 + readU24LE(bytes, 24), height: 1 + readU24LE(bytes, 27) };
  }
  if (
    kind === 'VP8 ' &&
    bytes.length >= 30 &&
    bytes[23] === 0x9d &&
    bytes[24] === 0x01 &&
    bytes[25] === 0x2a
  ) {
    return {
      width: (bytes[26] | (bytes[27] << 8)) & 0x3fff,
      height: (bytes[28] | (bytes[29] << 8)) & 0x3fff,
    };
  }
  if (kind === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
    return {
      width: 1 + bytes[21] + ((bytes[22] & 0x3f) << 8),
      height: 1 + (bytes[22] >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10),
    };
  }
  return undefined;
}

function assertKnownMagicDoesNotConflict(bytes: Uint8Array, mimeType: string): void {
  const detected =
    hasPrefix(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])
      ? 'application/pdf'
      : hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47])
        ? 'image/png'
        : hasPrefix(bytes, [0xff, 0xd8])
          ? 'image/jpeg'
          : undefined;
  if (detected && detected !== mimeType) throw new Error('Attachment MIME type conflicts with magic bytes.');
}

function normalizeMimeType(value: string): string {
  const mime = value.trim().toLowerCase();
  if (!MIME_PATTERN.test(mime)) throw new Error('Asset MIME type is invalid.');
  return mime;
}

function normalizeFileName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const leaf = value.replaceAll('\\', '/').split('/').at(-1) ?? '';
  const name = [...leaf]
    .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    .join('')
    .trim();
  if (!name || new TextEncoder().encode(name).byteLength > MAX_FILE_NAME_BYTES) {
    throw new Error('Asset file name is invalid.');
  }
  return name;
}

function copyBytes(bytes: Uint8Array): Uint8Array {
  if (!(bytes instanceof Uint8Array)) throw new Error('Asset bytes must be a Uint8Array.');
  return bytes.slice();
}

function hasPrefix(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((value, index) => bytes[index] === value);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function readU24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function text(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}
