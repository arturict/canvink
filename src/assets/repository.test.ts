import { describe, expect, it } from 'vitest';
import { jsPDF } from 'jspdf';
import { createCanvinkBundle, readCanvinkBundle } from '../io/canvinkBundle';
import { sha256Bytes } from '../domain/v2/hash';
import type { AssetBlob } from '../domain/v2';
import { MAX_PDF_FILE_BYTES } from '../domain/limits';
import {
  accessAttachment,
  ingestClipboardScreenshot,
  MemoryAssetRepository,
  reopenAsset,
  storeOriginalAsset,
} from './repository';

const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='),
  (character) => character.charCodeAt(0),
);

function bmp(width: number, height: number): Uint8Array {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const bytes = new Uint8Array(54 + rowSize * height);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0x42;
  bytes[1] = 0x4d; // 'BM'
  view.setUint32(2, bytes.length, true);
  view.setUint32(10, 54, true); // pixel data offset
  view.setUint32(14, 40, true); // BITMAPINFOHEADER size
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  view.setUint16(26, 1, true); // planes
  view.setUint16(28, 24, true); // bits per pixel
  return bytes;
}

function withPngDimensions(source: Uint8Array, width: number, height: number): Uint8Array {
  const bytes = source.slice();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(16, width);
  view.setUint32(20, height);
  let crc = 0xffff_ffff;
  for (const byte of bytes.subarray(12, 29)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 1 ? 0xedb8_8320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  view.setUint32(29, (crc ^ 0xffff_ffff) >>> 0);
  return bytes;
}

describe('content-addressed original assets', () => {
  it('stores, deduplicates, reopens, and round-trips original bytes through .canvink', async () => {
    const repository = new MemoryAssetRepository();
    const first = await ingestClipboardScreenshot(repository, {
      bytes: PNG,
      mimeType: 'image/png',
      fileName: 'shot.png',
    });
    const second = await ingestClipboardScreenshot(repository, {
      bytes: PNG,
      mimeType: 'image/png',
      fileName: 'shot.png',
    });
    expect(first.disposition).toBe('stored');
    expect(second.disposition).toBe('deduplicated');
    expect(await reopenAsset(repository, first.ref)).toEqual(PNG);

    const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
    pdf.text('Original worksheet', 40, 60);
    const pdfOriginal = new Uint8Array(pdf.output('arraybuffer'));
    const storedPdf = await storeOriginalAsset(repository, {
      bytes: pdfOriginal,
      mimeType: 'application/pdf',
      fileName: 'worksheet.pdf',
      kind: 'pdf',
    });

    const bundle = await createCanvinkBundle({
      createdAt: '2026-08-03T00:00:00.000Z',
      notebook: { id: 'notebook', bytes: new Uint8Array([1]), mimeType: 'application/octet-stream' },
      pages: [],
      assets: [
        { bytes: PNG, mimeType: 'image/png', originalName: 'shot.png' },
        { bytes: pdfOriginal, mimeType: 'application/pdf', originalName: 'worksheet.pdf' },
      ],
    });
    const imported = await readCanvinkBundle(bundle);
    const assetsById = new Map(imported.assets.map((asset) => [asset.id, asset]));
    expect(assetsById.get(first.ref.assetId)?.bytes).toEqual(PNG);
    expect(assetsById.get(storedPdf.ref.assetId)?.bytes).toEqual(pdfOriginal);
  });

  it('imports a BMP image by parsing its dimensions instead of aborting the whole import', async () => {
    const repository = new MemoryAssetRepository();
    const image = bmp(2, 2);
    // OneNote acquisition accepts image/bmp, so the asset store must too;
    // otherwise a single BMP throws and takes the entire notebook import down.
    const stored = await storeOriginalAsset(repository, {
      bytes: image,
      mimeType: 'image/bmp',
      fileName: 'scan.bmp',
      kind: 'image',
    });
    expect(stored.ref.mimeType).toBe('image/bmp');
    expect(await reopenAsset(repository, stored.ref)).toEqual(image);
  });

  it('returns attachment bytes without executing them and rejects magic conflicts', async () => {
    const repository = new MemoryAssetRepository();
    const stored = await storeOriginalAsset(repository, {
      bytes: new TextEncoder().encode('notes'),
      mimeType: 'text/plain',
      fileName: '../notes.txt',
      kind: 'attachment',
    });
    const access = await accessAttachment(repository, stored.ref, 'download');
    expect(access).toMatchObject({ fileName: 'notes.txt', mimeType: 'text/plain', disposition: 'download' });
    expect(new TextDecoder().decode(access.bytes)).toBe('notes');
    await expect(storeOriginalAsset(repository, {
      bytes: PNG,
      mimeType: 'application/octet-stream',
      kind: 'attachment',
    })).rejects.toThrow(/conflicts/);
  });

  it('fails closed on a stored checksum mismatch', async () => {
    const id = await sha256Bytes(PNG);
    const corrupt: AssetBlob = { assetId: id, checksum: id, size: 1, bytes: new Uint8Array([0]) };
    await expect(reopenAsset({
      getAsset: async () => corrupt,
      putAsset: async () => 'stored',
    }, { assetId: id, checksum: id, size: PNG.length, mimeType: 'image/png', role: 'original' })).rejects.toThrow(/integrity/);
  });

  it('enforces byte and decoded-pixel limits before storage', async () => {
    const repository = new MemoryAssetRepository();
    await expect(storeOriginalAsset(repository, {
      bytes: new Uint8Array(MAX_PDF_FILE_BYTES + 1),
      mimeType: 'application/pdf',
      kind: 'pdf',
    })).rejects.toThrow(/byte limit/);

    const oversizedDimensions = withPngDimensions(PNG, 65_535, 65_535);
    await expect(ingestClipboardScreenshot(repository, {
      bytes: oversizedDimensions,
      mimeType: 'image/png',
    })).rejects.toThrow(/pixel limit/);
  });
});
