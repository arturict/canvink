import { describe, expect, it } from 'vitest';
import {
  CANVINK_BUNDLE_FORMAT_VERSION,
  CanvinkBundleBlobWriter,
  createCanvinkBundle,
  openCanvinkBundle,
  readCanvinkBundle,
  type CanvinkBundleInput,
} from './canvinkBundle';

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

function fixture(): CanvinkBundleInput {
  return {
    createdAt: '2026-08-03T12:34:56.000Z',
    generator: 'Canvink test',
    notebook: {
      id: 'notebook-physics',
      bytes: text('notebook-automerge-document'),
    },
    pages: [
      { id: 'page-forces', bytes: text('page-one-automerge-document') },
      { id: 'page-waves', bytes: text('page-two-automerge-document') },
    ],
    assets: [
      {
        bytes: new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x11]),
        mimeType: 'application/pdf',
        originalName: 'worksheets/forces.pdf',
      },
      {
        bytes: new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x11]),
        mimeType: 'application/pdf',
        originalName: 'copy.pdf',
      },
      {
        bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        mimeType: 'image/png',
        originalName: 'diagram.png',
      },
    ],
  };
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function crc32(bytes: Uint8Array): number {
  let value = 0xffff_ffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb8_8320 ^ (value >>> 1) : value >>> 1;
    }
  }
  return (value ^ 0xffff_ffff) >>> 0;
}

function replaceManifestText(bundle: Uint8Array, search: string, replacement: string): Uint8Array {
  expect(replacement).toHaveLength(search.length);
  const result = bundle.slice();
  const view = new DataView(result.buffer);
  const manifestNameLength = view.getUint16(26, true);
  const manifestSize = view.getUint32(18, true);
  const manifestOffset = 30 + manifestNameLength;
  const manifest = new TextDecoder().decode(
    result.subarray(manifestOffset, manifestOffset + manifestSize),
  );
  const changed = manifest.replace(search, replacement);
  expect(changed).not.toBe(manifest);
  result.set(text(changed), manifestOffset);

  const updatedCrc = crc32(result.subarray(manifestOffset, manifestOffset + manifestSize));
  view.setUint32(14, updatedCrc, true);
  const endRecordOffset = result.length - 22;
  const centralOffset = readUint32(result, endRecordOffset + 16);
  view.setUint32(centralOffset + 16, updatedCrc, true);
  return result;
}

describe('.canvink bundle format', () => {
  it('round-trips notebook/page documents and deduplicates original assets by SHA-256', async () => {
    const bundle = await createCanvinkBundle(fixture());
    const imported = await readCanvinkBundle(bundle);

    expect(imported.manifest.formatVersion).toBe(CANVINK_BUNDLE_FORMAT_VERSION);
    expect(imported.manifest.schemaVersion).toBe(3);
    expect(imported.notebook.id).toBe('notebook-physics');
    expect(new TextDecoder().decode(imported.notebook.bytes)).toBe(
      'notebook-automerge-document',
    );
    expect(imported.pages.map((page) => page.id)).toEqual(['page-forces', 'page-waves']);
    expect(imported.assets).toHaveLength(2);
    expect(imported.assets.map((asset) => asset.sha256)).toEqual(
      [...imported.assets.map((asset) => asset.sha256)].sort(),
    );
    const pdf = imported.assets.find((asset) => asset.mimeType === 'application/pdf');
    expect(pdf?.id).toBe(`sha256:${pdf?.sha256}`);
    expect(pdf?.originalNames).toEqual(['copy.pdf', 'forces.pdf']);
    expect(pdf?.bytes).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x11]));
  });

  it('writes byte-for-byte deterministic archives for the same normalized input', async () => {
    const first = await createCanvinkBundle(fixture());
    const second = await createCanvinkBundle(fixture());

    expect(second).toEqual(first);
  });

  it('keeps legacy format-v2 bundles readable while new writers bind format and schema', async () => {
    const current = await createCanvinkBundle(fixture());
    const v2Input = fixture();
    v2Input.schemaVersion = 2;
    const v2 = await createCanvinkBundle(v2Input);
    const schemaLine = '"schemaVersion": 2,';
    const legacy = replaceManifestText(v2, schemaLine, ' '.repeat(schemaLine.length));

    expect((await readCanvinkBundle(current)).manifest).toMatchObject({ formatVersion: 3, schemaVersion: 3 });
    expect((await readCanvinkBundle(v2)).manifest).toMatchObject({ formatVersion: 2, schemaVersion: 2 });
    expect((await readCanvinkBundle(legacy)).manifest).toMatchObject({ formatVersion: 2, schemaVersion: 2 });
  });

  it('rejects mixed, tampered, and downgrade manifest version bindings', async () => {
    const current = await createCanvinkBundle(fixture());
    const downgraded = replaceManifestText(current, '"formatVersion": 3', '"formatVersion": 2');
    const tamperedSchema = replaceManifestText(current, '"schemaVersion": 3', '"schemaVersion": 2');

    await expect(readCanvinkBundle(downgraded)).rejects.toThrow(/do not match/);
    await expect(readCanvinkBundle(tamperedSchema)).rejects.toThrow(/do not match/);
  });

  it('round-trips OneNote-normalized tags and task state inside the opaque page document', async () => {
    const input = fixture();
    input.pages = [{
      id: 'page-onenote',
      bytes: text(JSON.stringify({ tags: ['important', 'onenote:customer-follow-up', 'todo'], taskState: 'open' })),
    }];
    const imported = await readCanvinkBundle(await createCanvinkBundle(input));
    const page = JSON.parse(new TextDecoder().decode(imported.pages[0].bytes)) as {
      tags: string[];
      taskState: string;
    };
    expect(page).toEqual({
      tags: ['important', 'onenote:customer-follow-up', 'todo'],
      taskState: 'open',
    });
  });

  it('rejects duplicate asset bytes that are assigned conflicting MIME types', async () => {
    const input = fixture();
    input.assets[1].mimeType = 'application/octet-stream';

    await expect(createCanvinkBundle(input)).rejects.toThrow('conflicting MIME types');
  });

  it('rejects payload tampering at the ZIP CRC layer', async () => {
    const bundle = await createCanvinkBundle(fixture());
    const tampered = bundle.slice();
    const marker = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x11]);
    const offset = tampered.findIndex((byte, index) =>
      marker.every((markerByte, markerIndex) => tampered[index + markerIndex] === markerByte),
    );
    expect(offset).toBeGreaterThan(0);
    tampered[offset] ^= 0xff;

    await expect(readCanvinkBundle(tampered)).rejects.toThrow('CRC verification failed');
  });

  it('verifies manifest SHA-256 even when the ZIP CRC is internally consistent', async () => {
    const bundle = await createCanvinkBundle(fixture());
    const valid = await readCanvinkBundle(bundle);
    const originalHash = valid.manifest.notebook.document.sha256;
    const replacementHash = `${originalHash[0] === '0' ? '1' : '0'}${originalHash.slice(1)}`;
    const tampered = replaceManifestText(bundle, originalHash, replacementHash);

    await expect(readCanvinkBundle(tampered)).rejects.toThrow(
      'documents/notebook.bin failed SHA-256 verification',
    );
  });

  it('enforces count and per-entry import limits before yielding an import candidate', async () => {
    const bundle = await createCanvinkBundle(fixture());

    await expect(readCanvinkBundle(bundle, { maxPageDocuments: 1 })).rejects.toThrow(
      'too many page documents',
    );
    await expect(readCanvinkBundle(bundle, { maxAssetBytes: 4 })).rejects.toThrow(
      'import limit',
    );
    await expect(readCanvinkBundle(bundle, { maxBundleBytes: bundle.length - 1 })).rejects.toThrow(
      'Bundle must be between',
    );
  });

  it('keeps caller state unchanged when a staged import fails', async () => {
    const bundle = await createCanvinkBundle(fixture());
    const invalidVersion = replaceManifestText(bundle, '"formatVersion": 3', '"formatVersion": 4');
    const state = { notebook: 'existing notebook' };

    try {
      const imported = await readCanvinkBundle(invalidVersion);
      state.notebook = imported.notebook.id;
    } catch {
      // The caller commits only after the importer returns a fully verified candidate.
    }

    expect(state).toEqual({ notebook: 'existing notebook' });
  });

  it('writes the same bytes page by page into a Blob and reads them back entry by entry', async () => {
    const input = fixture();
    const writer = new CanvinkBundleBlobWriter({ createdAt: input.createdAt, generator: input.generator });
    await writer.setNotebook(input.notebook);
    for (const page of input.pages) await writer.addPage(page);
    // Assets may arrive in any order; the writer keeps canonical SHA-256 order.
    for (const asset of [...input.assets].reverse()) await writer.addAsset(asset);
    const blob = writer.finish();
    const streamed = new Uint8Array(await blob.arrayBuffer());
    const whole = await createCanvinkBundle({ ...input, assets: [...input.assets].reverse() });
    expect(streamed).toEqual(whole);

    const opened = await openCanvinkBundle(blob);
    expect(opened.manifest.pages.map((page) => page.id)).toEqual(['page-forces', 'page-waves']);
    expect(new TextDecoder().decode((await opened.readPage(1)).bytes)).toBe('page-two-automerge-document');
    expect((await opened.readAsset(0)).sha256).toBe(opened.manifest.assets[0].sha256);

    const tampered = streamed.slice();
    const target = new TextEncoder().encode('page-two-automerge-document');
    const at = tampered.findIndex((_, index) => target.every((byte, offset) => tampered[index + offset] === byte));
    tampered[at] ^= 1;
    const reopened = await openCanvinkBundle(new Blob([tampered]));
    await expect(reopened.readPage(1)).rejects.toThrow(/CRC|SHA-256/);
  });
});
