const encoder = new TextEncoder();
const strictDecoder = new TextDecoder('utf-8', { fatal: true });

export const CANVINK_BUNDLE_FORMAT = 'canvink' as const;
export const CANVINK_BUNDLE_LEGACY_FORMAT_VERSION = 2 as const;
export const CANVINK_BUNDLE_FORMAT_VERSION = 3 as const;
export const CANVINK_BUNDLE_MIME_TYPE = 'application/vnd.canvink.bundle+zip' as const;

const MANIFEST_PATH = 'manifest.json';
const NOTEBOOK_DOCUMENT_PATH = 'documents/notebook.bin';
const PAGE_DOCUMENT_MIME_TYPE = 'application/vnd.canvink.page+automerge';
const NOTEBOOK_DOCUMENT_MIME_TYPE = 'application/vnd.canvink.notebook+automerge';
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MIME_TYPE_PATTERN =
  /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const UINT32_MAX = 0xffff_ffff;

export interface CanvinkBundleDocumentInput {
  id: string;
  bytes: Uint8Array;
  mimeType?: string;
}

export interface CanvinkBundleAssetInput {
  bytes: Uint8Array;
  mimeType: string;
  originalName?: string;
}

export interface CanvinkBundleInput {
  /** Workspace document schema carried by every embedded Automerge document. */
  schemaVersion?: 2 | 3;
  createdAt: string;
  generator?: string;
  notebook: CanvinkBundleDocumentInput;
  pages: CanvinkBundleDocumentInput[];
  assets: CanvinkBundleAssetInput[];
}

export interface CanvinkBundlePayloadDescriptor {
  path: string;
  mimeType: string;
  size: number;
  sha256: string;
}

export interface CanvinkBundleManifest {
  format: typeof CANVINK_BUNDLE_FORMAT;
  formatVersion:
    | typeof CANVINK_BUNDLE_LEGACY_FORMAT_VERSION
    | typeof CANVINK_BUNDLE_FORMAT_VERSION;
  schemaVersion: 2 | 3;
  createdAt: string;
  generator?: string;
  notebook: {
    id: string;
    document: CanvinkBundlePayloadDescriptor;
  };
  pages: Array<{
    id: string;
    document: CanvinkBundlePayloadDescriptor;
  }>;
  assets: Array<
    CanvinkBundlePayloadDescriptor & {
      id: string;
      originalNames: string[];
    }
  >;
}

export interface ImportedCanvinkDocument {
  id: string;
  bytes: Uint8Array;
  mimeType: string;
  sha256: string;
}

export interface ImportedCanvinkAsset {
  id: string;
  bytes: Uint8Array;
  mimeType: string;
  sha256: string;
  originalNames: string[];
}

/**
 * A complete, verified import candidate. Reading a bundle has no storage or UI
 * side effects; callers can stage this value and only then replace state.
 */
export interface ImportedCanvinkBundle {
  manifest: CanvinkBundleManifest;
  notebook: ImportedCanvinkDocument;
  pages: ImportedCanvinkDocument[];
  assets: ImportedCanvinkAsset[];
}

export interface CanvinkBundleImportLimits {
  maxBundleBytes: number;
  maxManifestBytes: number;
  maxEntries: number;
  maxPageDocuments: number;
  maxAssets: number;
  maxDocumentBytes: number;
  maxAssetBytes: number;
  maxTotalUncompressedBytes: number;
  maxIdentifierBytes: number;
  maxOriginalNamesPerAsset: number;
}

export const DEFAULT_CANVINK_BUNDLE_IMPORT_LIMITS = Object.freeze({
  maxBundleBytes: 256 * 1024 * 1024,
  maxManifestBytes: 4 * 1024 * 1024,
  maxEntries: 20_002,
  maxPageDocuments: 10_000,
  maxAssets: 10_000,
  maxDocumentBytes: 32 * 1024 * 1024,
  maxAssetBytes: 64 * 1024 * 1024,
  maxTotalUncompressedBytes: 512 * 1024 * 1024,
  maxIdentifierBytes: 16 * 1024,
  maxOriginalNamesPerAsset: 64,
}) satisfies Readonly<CanvinkBundleImportLimits>;

export interface ZipEntry {
  path: string;
  bytes: Uint8Array;
}

interface PreparedAsset {
  bytes: Uint8Array;
  mimeType: string;
  sha256: string;
  originalNames: Set<string>;
}

function assertBytes(value: Uint8Array, label: string): Uint8Array {
  if (!(value instanceof Uint8Array)) {
    throw new Error(`${label} must be binary data.`);
  }
  return value.slice();
}

function assertIdentifier(value: string, label: string, maxBytes = 16 * 1024): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    hasControlCharacter(value) ||
    encoder.encode(value).length > maxBytes
  ) {
    throw new Error(`${label} is empty, contains control characters, or is too long.`);
  }
  return value;
}

function normalizeMimeType(value: string, label: string): string {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!MIME_TYPE_PATTERN.test(normalized)) {
    throw new Error(`${label} is not a valid canonical MIME type.`);
  }
  return normalized;
}

function assertTimestamp(value: string): string {
  if (!ISO_UTC_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error('Bundle createdAt must be an ISO 8601 UTC timestamp.');
  }
  return value;
}

function normalizeOriginalName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const basename = value.split(/[\\/]/).at(-1)?.trim() ?? '';
  if (
    basename.length === 0 ||
    hasControlCharacter(basename) ||
    encoder.encode(basename).length > 255
  ) {
    throw new Error('Asset originalName is empty, contains control characters, or is too long.');
  }
  return basename;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('SHA-256 is unavailable in this runtime.');
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  return left.every((byte, index) => byte === right[index]);
}

function compareCanonicalStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function descriptor(
  path: string,
  mimeType: string,
  bytes: Uint8Array,
  digest: string,
): CanvinkBundlePayloadDescriptor {
  return { path, mimeType, size: bytes.length, sha256: digest };
}

/** Create a deterministic ZIP32 bundle. Identical normalized input produces identical bytes. */
export async function createCanvinkBundle(input: CanvinkBundleInput): Promise<Uint8Array> {
  const schemaVersion = input.schemaVersion ?? CANVINK_BUNDLE_FORMAT_VERSION;
  const createdAt = assertTimestamp(input.createdAt);
  const generator =
    input.generator === undefined
      ? undefined
      : assertIdentifier(input.generator, 'Bundle generator', 1024);
  const notebookId = assertIdentifier(input.notebook.id, 'Notebook ID');
  const notebookBytes = assertBytes(input.notebook.bytes, 'Notebook document');
  const notebookMimeType = normalizeMimeType(
    input.notebook.mimeType ?? NOTEBOOK_DOCUMENT_MIME_TYPE,
    'Notebook document MIME type',
  );
  const notebookHash = await sha256(notebookBytes);

  const pageIds = new Set<string>();
  const preparedPages = await Promise.all(
    input.pages.map(async (page, index) => {
      const id = assertIdentifier(page.id, `Page ${index + 1} ID`);
      if (pageIds.has(id)) throw new Error(`Duplicate page ID: ${id}`);
      pageIds.add(id);
      const bytes = assertBytes(page.bytes, `Page ${index + 1} document`);
      return {
        id,
        bytes,
        mimeType: normalizeMimeType(
          page.mimeType ?? PAGE_DOCUMENT_MIME_TYPE,
          `Page ${index + 1} document MIME type`,
        ),
        sha256: await sha256(bytes),
        path: `documents/pages/${index.toString().padStart(8, '0')}.bin`,
      };
    }),
  );

  const assetsByHash = new Map<string, PreparedAsset>();
  for (const [index, asset] of input.assets.entries()) {
    const bytes = assertBytes(asset.bytes, `Asset ${index + 1}`);
    const mimeType = normalizeMimeType(asset.mimeType, `Asset ${index + 1} MIME type`);
    const digest = await sha256(bytes);
    const originalName = normalizeOriginalName(asset.originalName);
    const existing = assetsByHash.get(digest);
    if (existing) {
      if (!equalBytes(existing.bytes, bytes)) {
        throw new Error('Two different assets produced the same SHA-256 digest.');
      }
      if (existing.mimeType !== mimeType) {
        throw new Error(`Duplicate asset ${digest} has conflicting MIME types.`);
      }
      if (originalName) existing.originalNames.add(originalName);
      continue;
    }
    assetsByHash.set(digest, {
      bytes,
      mimeType,
      sha256: digest,
      originalNames: new Set(originalName ? [originalName] : []),
    });
  }
  const preparedAssets = [...assetsByHash.values()].sort((left, right) =>
    compareCanonicalStrings(left.sha256, right.sha256),
  );

  const manifest: CanvinkBundleManifest = {
    format: CANVINK_BUNDLE_FORMAT,
    formatVersion: schemaVersion,
    schemaVersion,
    createdAt,
    ...(generator ? { generator } : {}),
    notebook: {
      id: notebookId,
      document: descriptor(
        NOTEBOOK_DOCUMENT_PATH,
        notebookMimeType,
        notebookBytes,
        notebookHash,
      ),
    },
    pages: preparedPages.map((page) => ({
      id: page.id,
      document: descriptor(page.path, page.mimeType, page.bytes, page.sha256),
    })),
    assets: preparedAssets.map((asset) => ({
      id: `sha256:${asset.sha256}`,
      ...descriptor(
        `assets/${asset.sha256}`,
        asset.mimeType,
        asset.bytes,
        asset.sha256,
      ),
      originalNames: [...asset.originalNames].sort(compareCanonicalStrings),
    })),
  };

  const entries: ZipEntry[] = [
    { path: MANIFEST_PATH, bytes: encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`) },
    { path: NOTEBOOK_DOCUMENT_PATH, bytes: notebookBytes },
    ...preparedPages.map((page) => ({ path: page.path, bytes: page.bytes })),
    ...preparedAssets.map((asset) => ({
      path: `assets/${asset.sha256}`,
      bytes: asset.bytes,
    })),
  ];
  return writeStoredZip(entries);
}

/**
 * Parse and verify a bundle without changing application state. The promise
 * rejects before returning any import candidate if any limit or integrity check fails.
 */
export async function readCanvinkBundle(
  source: Uint8Array | ArrayBuffer,
  limitOverrides: Partial<CanvinkBundleImportLimits> = {},
): Promise<ImportedCanvinkBundle> {
  const limits = resolveLimits(limitOverrides);
  const bytes = source instanceof Uint8Array ? source.slice() : new Uint8Array(source.slice(0));
  if (bytes.length === 0 || bytes.length > limits.maxBundleBytes) {
    throw new Error(`Bundle must be between 1 byte and ${limits.maxBundleBytes} bytes.`);
  }

  const archive = readStoredZip(bytes, limits);
  const manifestBytes = archive.get(MANIFEST_PATH);
  if (!manifestBytes) throw new Error('Bundle is missing manifest.json.');
  if (manifestBytes.length > limits.maxManifestBytes) {
    throw new Error('Bundle manifest exceeds the configured import limit.');
  }

  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(strictDecoder.decode(manifestBytes));
  } catch (error) {
    throw new Error('Bundle manifest is not valid UTF-8 JSON.', { cause: error });
  }
  const manifest = validateManifest(rawManifest, limits);
  const expectedArchivePaths = [
    MANIFEST_PATH,
    manifest.notebook.document.path,
    ...manifest.pages.map((page) => page.document.path),
    ...manifest.assets.map((asset) => asset.path),
  ];
  const archivePaths = [...archive.keys()];
  if (
    archivePaths.length !== expectedArchivePaths.length ||
    archivePaths.some((path, index) => path !== expectedArchivePaths[index])
  ) {
    throw new Error('Bundle entries are missing, unreferenced, or not in canonical order.');
  }
  const referencedPaths = new Set<string>([MANIFEST_PATH]);

  const resolvePayload = async (
    payload: CanvinkBundlePayloadDescriptor,
    kind: 'document' | 'asset',
  ): Promise<Uint8Array> => {
    if (referencedPaths.has(payload.path)) {
      throw new Error(`Bundle path is referenced more than once: ${payload.path}`);
    }
    referencedPaths.add(payload.path);
    const payloadBytes = archive.get(payload.path);
    if (!payloadBytes) throw new Error(`Bundle is missing ${payload.path}.`);
    const perEntryLimit =
      kind === 'asset' ? limits.maxAssetBytes : limits.maxDocumentBytes;
    if (payloadBytes.length > perEntryLimit) {
      throw new Error(`${payload.path} exceeds the configured ${kind} import limit.`);
    }
    if (payloadBytes.length !== payload.size) {
      throw new Error(`${payload.path} size does not match its manifest entry.`);
    }
    const digest = await sha256(payloadBytes);
    if (digest !== payload.sha256) {
      throw new Error(`${payload.path} failed SHA-256 verification.`);
    }
    return payloadBytes.slice();
  };

  const notebookBytes = await resolvePayload(manifest.notebook.document, 'document');
  const pages: ImportedCanvinkDocument[] = [];
  for (const page of manifest.pages) {
    pages.push({
      id: page.id,
      bytes: await resolvePayload(page.document, 'document'),
      mimeType: page.document.mimeType,
      sha256: page.document.sha256,
    });
  }
  const assets: ImportedCanvinkAsset[] = [];
  for (const asset of manifest.assets) {
    assets.push({
      id: asset.id,
      bytes: await resolvePayload(asset, 'asset'),
      mimeType: asset.mimeType,
      sha256: asset.sha256,
      originalNames: [...asset.originalNames],
    });
  }

  if (archive.size !== referencedPaths.size) {
    const unreferenced = [...archive.keys()].find((path) => !referencedPaths.has(path));
    throw new Error(`Bundle contains an unreferenced entry: ${unreferenced ?? 'unknown'}.`);
  }

  return {
    manifest,
    notebook: {
      id: manifest.notebook.id,
      bytes: notebookBytes,
      mimeType: manifest.notebook.document.mimeType,
      sha256: manifest.notebook.document.sha256,
    },
    pages,
    assets,
  };
}

function resolveLimits(
  overrides: Partial<CanvinkBundleImportLimits>,
): CanvinkBundleImportLimits {
  const limits = { ...DEFAULT_CANVINK_BUNDLE_IMPORT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`Import limit ${name} must be a positive safe integer.`);
    }
  }
  return limits;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function asInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return value as number;
}

function asString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
  return value;
}

function validatePayloadDescriptor(
  value: unknown,
  label: string,
  expectedPath: string,
): CanvinkBundlePayloadDescriptor {
  const record = asRecord(value, label);
  const path = asString(record.path, `${label}.path`);
  if (path !== expectedPath) throw new Error(`${label}.path is not canonical.`);
  const sha = asString(record.sha256, `${label}.sha256`);
  if (!SHA256_PATTERN.test(sha)) throw new Error(`${label}.sha256 is invalid.`);
  return {
    path,
    mimeType: normalizeMimeType(asString(record.mimeType, `${label}.mimeType`), `${label}.mimeType`),
    size: asInteger(record.size, `${label}.size`),
    sha256: sha,
  };
}

function validateManifest(
  value: unknown,
  limits: CanvinkBundleImportLimits,
): CanvinkBundleManifest {
  const record = asRecord(value, 'Bundle manifest');
  if (record.format !== CANVINK_BUNDLE_FORMAT) {
    throw new Error('File is not a Canvink bundle.');
  }
  if (
    record.formatVersion !== CANVINK_BUNDLE_LEGACY_FORMAT_VERSION
    && record.formatVersion !== CANVINK_BUNDLE_FORMAT_VERSION
  ) {
    throw new Error(`Unsupported Canvink bundle format version: ${String(record.formatVersion)}.`);
  }
  const formatVersion = record.formatVersion as 2 | 3;
  // The original v2 manifest predates schemaVersion. It is the only accepted
  // omission; v3 and all newly written bundles bind both values explicitly.
  const schemaVersion = record.schemaVersion === undefined && formatVersion === 2
    ? 2
    : record.schemaVersion;
  if ((schemaVersion !== 2 && schemaVersion !== 3) || schemaVersion !== formatVersion) {
    throw new Error('Bundle formatVersion and schemaVersion do not match.');
  }
  const createdAt = assertTimestamp(asString(record.createdAt, 'Bundle manifest createdAt'));
  const generator =
    record.generator === undefined
      ? undefined
      : assertIdentifier(
          asString(record.generator, 'Bundle manifest generator'),
          'Bundle manifest generator',
          1024,
        );
  const notebookRecord = asRecord(record.notebook, 'Bundle notebook');
  const notebookId = assertIdentifier(
    asString(notebookRecord.id, 'Bundle notebook ID'),
    'Bundle notebook ID',
    limits.maxIdentifierBytes,
  );
  const notebookDocument = validatePayloadDescriptor(
    notebookRecord.document,
    'Bundle notebook document',
    NOTEBOOK_DOCUMENT_PATH,
  );
  if (notebookDocument.size > limits.maxDocumentBytes) {
    throw new Error('Notebook document exceeds the configured import limit.');
  }

  if (!Array.isArray(record.pages)) throw new Error('Bundle pages must be an array.');
  if (record.pages.length > limits.maxPageDocuments) {
    throw new Error('Bundle contains too many page documents.');
  }
  const pageIds = new Set<string>();
  const pages = record.pages.map((value, index) => {
    const page = asRecord(value, `Bundle page ${index + 1}`);
    const id = assertIdentifier(
      asString(page.id, `Bundle page ${index + 1} ID`),
      `Bundle page ${index + 1} ID`,
      limits.maxIdentifierBytes,
    );
    if (pageIds.has(id)) throw new Error(`Duplicate page ID: ${id}`);
    pageIds.add(id);
    const document = validatePayloadDescriptor(
      page.document,
      `Bundle page ${index + 1} document`,
      `documents/pages/${index.toString().padStart(8, '0')}.bin`,
    );
    if (document.size > limits.maxDocumentBytes) {
      throw new Error(`Bundle page ${index + 1} exceeds the configured import limit.`);
    }
    return { id, document };
  });

  if (!Array.isArray(record.assets)) throw new Error('Bundle assets must be an array.');
  if (record.assets.length > limits.maxAssets) {
    throw new Error('Bundle contains too many assets.');
  }
  const assetIds = new Set<string>();
  const assets = record.assets.map((value, index) => {
    const asset = asRecord(value, `Bundle asset ${index + 1}`);
    const sha = asString(asset.sha256, `Bundle asset ${index + 1}.sha256`);
    if (!SHA256_PATTERN.test(sha)) throw new Error(`Bundle asset ${index + 1}.sha256 is invalid.`);
    const payload = validatePayloadDescriptor(
      asset,
      `Bundle asset ${index + 1}`,
      `assets/${sha}`,
    );
    const id = asString(asset.id, `Bundle asset ${index + 1}.id`);
    if (id !== `sha256:${sha}`) throw new Error(`Bundle asset ${index + 1}.id is not canonical.`);
    if (assetIds.has(id)) throw new Error(`Duplicate asset ID: ${id}`);
    assetIds.add(id);
    if (payload.size > limits.maxAssetBytes) {
      throw new Error(`Bundle asset ${index + 1} exceeds the configured import limit.`);
    }
    if (!Array.isArray(asset.originalNames)) {
      throw new Error(`Bundle asset ${index + 1}.originalNames must be an array.`);
    }
    if (asset.originalNames.length > limits.maxOriginalNamesPerAsset) {
      throw new Error(`Bundle asset ${index + 1} has too many original names.`);
    }
    const originalNames = asset.originalNames.map((name) => {
      const original = asString(name, `Bundle asset ${index + 1} original name`);
      if (normalizeOriginalName(original) !== original) {
        throw new Error(`Bundle asset ${index + 1} contains a non-canonical original name.`);
      }
      return original;
    });
    if (new Set(originalNames).size !== originalNames.length) {
      throw new Error(`Bundle asset ${index + 1} contains duplicate original names.`);
    }
    const sortedNames = [...originalNames].sort(compareCanonicalStrings);
    if (sortedNames.some((name, nameIndex) => name !== originalNames[nameIndex])) {
      throw new Error(`Bundle asset ${index + 1} original names are not sorted.`);
    }
    return { id, ...payload, originalNames };
  });
  const sortedAssets = [...assets].sort((left, right) =>
    compareCanonicalStrings(left.sha256, right.sha256),
  );
  if (sortedAssets.some((asset, index) => asset.sha256 !== assets[index].sha256)) {
    throw new Error('Bundle assets are not in canonical SHA-256 order.');
  }

  return {
    format: CANVINK_BUNDLE_FORMAT,
    formatVersion,
    schemaVersion,
    createdAt,
    ...(generator ? { generator } : {}),
    notebook: { id: notebookId, document: notebookDocument },
    pages,
    assets,
  };
}

const crcTable = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb8_8320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let value = 0xffff_ffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffff_ffff) >>> 0;
}

function writeUint16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}

function writeUint32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value, true);
}

export function writeStoredZip(entries: ZipEntry[]): Uint8Array {
  if (entries.length > 0xffff) throw new Error('Bundle has too many ZIP entries.');
  const prepared = entries.map((entry) => ({
    ...entry,
    name: encoder.encode(entry.path),
    crc: crc32(entry.bytes),
  }));
  for (const entry of prepared) {
    if (entry.name.length > 0xffff || entry.bytes.length > UINT32_MAX) {
      throw new Error(`Bundle entry cannot be represented in ZIP32: ${entry.path}`);
    }
  }
  const localSize = prepared.reduce(
    (total, entry) => total + 30 + entry.name.length + entry.bytes.length,
    0,
  );
  const centralSize = prepared.reduce((total, entry) => total + 46 + entry.name.length, 0);
  const totalSize = localSize + centralSize + 22;
  if (totalSize > UINT32_MAX) throw new Error('Bundle cannot be represented in ZIP32.');

  const output = new Uint8Array(totalSize);
  const view = new DataView(output.buffer);
  const localOffsets: number[] = [];
  let offset = 0;
  for (const entry of prepared) {
    localOffsets.push(offset);
    writeUint32(view, offset, 0x0403_4b50);
    writeUint16(view, offset + 4, 20);
    writeUint16(view, offset + 6, 0x0800);
    writeUint16(view, offset + 8, 0);
    writeUint16(view, offset + 10, 0);
    writeUint16(view, offset + 12, 0x0021);
    writeUint32(view, offset + 14, entry.crc);
    writeUint32(view, offset + 18, entry.bytes.length);
    writeUint32(view, offset + 22, entry.bytes.length);
    writeUint16(view, offset + 26, entry.name.length);
    writeUint16(view, offset + 28, 0);
    output.set(entry.name, offset + 30);
    output.set(entry.bytes, offset + 30 + entry.name.length);
    offset += 30 + entry.name.length + entry.bytes.length;
  }
  const centralOffset = offset;
  prepared.forEach((entry, index) => {
    writeUint32(view, offset, 0x0201_4b50);
    writeUint16(view, offset + 4, 20);
    writeUint16(view, offset + 6, 20);
    writeUint16(view, offset + 8, 0x0800);
    writeUint16(view, offset + 10, 0);
    writeUint16(view, offset + 12, 0);
    writeUint16(view, offset + 14, 0x0021);
    writeUint32(view, offset + 16, entry.crc);
    writeUint32(view, offset + 20, entry.bytes.length);
    writeUint32(view, offset + 24, entry.bytes.length);
    writeUint16(view, offset + 28, entry.name.length);
    writeUint16(view, offset + 30, 0);
    writeUint16(view, offset + 32, 0);
    writeUint16(view, offset + 34, 0);
    writeUint16(view, offset + 36, 0);
    writeUint32(view, offset + 38, 0);
    writeUint32(view, offset + 42, localOffsets[index]);
    output.set(entry.name, offset + 46);
    offset += 46 + entry.name.length;
  });
  writeUint32(view, offset, 0x0605_4b50);
  writeUint16(view, offset + 4, 0);
  writeUint16(view, offset + 6, 0);
  writeUint16(view, offset + 8, prepared.length);
  writeUint16(view, offset + 10, prepared.length);
  writeUint32(view, offset + 12, centralSize);
  writeUint32(view, offset + 16, centralOffset);
  writeUint16(view, offset + 20, 0);
  return output;
}

function readUint16(view: DataView, offset: number, label: string): number {
  if (offset < 0 || offset + 2 > view.byteLength) throw new Error(`Truncated ZIP ${label}.`);
  return view.getUint16(offset, true);
}

function readUint32(view: DataView, offset: number, label: string): number {
  if (offset < 0 || offset + 4 > view.byteLength) throw new Error(`Truncated ZIP ${label}.`);
  return view.getUint32(offset, true);
}

function assertArchivePath(path: string): void {
  if (
    path.length === 0 ||
    !/^[\x20-\x7e]+$/.test(path) ||
    path.includes('\\') ||
    path.startsWith('/') ||
    path.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`Bundle contains an unsafe ZIP path: ${JSON.stringify(path)}.`);
  }
}

function readStoredZip(
  source: Uint8Array,
  limits: CanvinkBundleImportLimits,
): Map<string, Uint8Array> {
  if (source.length < 22) throw new Error('Bundle is too short to be a ZIP archive.');
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  const eocdOffset = source.length - 22;
  if (readUint32(view, eocdOffset, 'end record') !== 0x0605_4b50) {
    throw new Error('Bundle does not have a canonical ZIP end record.');
  }
  if (
    readUint16(view, eocdOffset + 4, 'disk number') !== 0 ||
    readUint16(view, eocdOffset + 6, 'central disk') !== 0 ||
    readUint16(view, eocdOffset + 20, 'comment length') !== 0
  ) {
    throw new Error('Multi-disk or commented ZIP bundles are not supported.');
  }
  const diskEntries = readUint16(view, eocdOffset + 8, 'disk entry count');
  const totalEntries = readUint16(view, eocdOffset + 10, 'entry count');
  if (diskEntries !== totalEntries) throw new Error('ZIP entry counts do not match.');
  if (totalEntries < 2 || totalEntries > limits.maxEntries) {
    throw new Error('Bundle ZIP entry count is outside the configured import limit.');
  }
  const centralSize = readUint32(view, eocdOffset + 12, 'central size');
  const centralOffset = readUint32(view, eocdOffset + 16, 'central offset');
  if (centralOffset + centralSize !== eocdOffset) {
    throw new Error('Bundle ZIP central directory bounds are invalid.');
  }

  const entries = new Map<string, Uint8Array>();
  let centralCursor = centralOffset;
  let expectedLocalOffset = 0;
  let totalUncompressed = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    if (readUint32(view, centralCursor, 'central header') !== 0x0201_4b50) {
      throw new Error('Bundle ZIP central directory is malformed.');
    }
    const flags = readUint16(view, centralCursor + 8, 'central flags');
    const method = readUint16(view, centralCursor + 10, 'central method');
    const modifiedTime = readUint16(view, centralCursor + 12, 'central modified time');
    const modifiedDate = readUint16(view, centralCursor + 14, 'central modified date');
    const crc = readUint32(view, centralCursor + 16, 'central CRC');
    const compressedSize = readUint32(view, centralCursor + 20, 'central compressed size');
    const uncompressedSize = readUint32(view, centralCursor + 24, 'central uncompressed size');
    const nameLength = readUint16(view, centralCursor + 28, 'central name length');
    const extraLength = readUint16(view, centralCursor + 30, 'central extra length');
    const commentLength = readUint16(view, centralCursor + 32, 'central comment length');
    const disk = readUint16(view, centralCursor + 34, 'central disk start');
    const localOffset = readUint32(view, centralCursor + 42, 'local offset');
    const centralEnd = centralCursor + 46 + nameLength + extraLength + commentLength;
    if (centralEnd > eocdOffset) throw new Error('Truncated ZIP central entry.');
    if (
      readUint16(view, centralCursor + 4, 'creator version') !== 20 ||
      readUint16(view, centralCursor + 6, 'required version') !== 20 ||
      flags !== 0x0800 ||
      method !== 0 ||
      modifiedTime !== 0 ||
      modifiedDate !== 0x0021 ||
      extraLength !== 0 ||
      commentLength !== 0 ||
      disk !== 0 ||
      readUint16(view, centralCursor + 36, 'internal attributes') !== 0 ||
      readUint32(view, centralCursor + 38, 'external attributes') !== 0
    ) {
      throw new Error('Bundle entries must use the canonical uncompressed ZIP32 profile.');
    }
    if (compressedSize !== uncompressedSize) {
      throw new Error('Compressed bundle entries are not supported.');
    }
    totalUncompressed += uncompressedSize;
    if (!Number.isSafeInteger(totalUncompressed) || totalUncompressed > limits.maxTotalUncompressedBytes) {
      throw new Error('Bundle exceeds the total uncompressed import limit.');
    }
    const nameBytes = source.subarray(centralCursor + 46, centralCursor + 46 + nameLength);
    let path: string;
    try {
      path = strictDecoder.decode(nameBytes);
    } catch (error) {
      throw new Error('Bundle contains an invalid UTF-8 ZIP path.', { cause: error });
    }
    assertArchivePath(path);
    if (entries.has(path)) throw new Error(`Bundle contains a duplicate ZIP path: ${path}.`);
    const entryLimit =
      path === MANIFEST_PATH
        ? limits.maxManifestBytes
        : path.startsWith('documents/')
          ? limits.maxDocumentBytes
          : limits.maxAssetBytes;
    if (uncompressedSize > entryLimit) {
      throw new Error(`${path} exceeds its configured ZIP entry import limit.`);
    }
    if (localOffset !== expectedLocalOffset) {
      throw new Error('Bundle ZIP local entries are overlapping, reordered, or contain gaps.');
    }
    if (readUint32(view, localOffset, 'local header') !== 0x0403_4b50) {
      throw new Error('Bundle ZIP local header is malformed.');
    }
    const localFlags = readUint16(view, localOffset + 6, 'local flags');
    const localMethod = readUint16(view, localOffset + 8, 'local method');
    const localModifiedTime = readUint16(view, localOffset + 10, 'local modified time');
    const localModifiedDate = readUint16(view, localOffset + 12, 'local modified date');
    const localCrc = readUint32(view, localOffset + 14, 'local CRC');
    const localCompressedSize = readUint32(view, localOffset + 18, 'local compressed size');
    const localUncompressedSize = readUint32(view, localOffset + 22, 'local uncompressed size');
    const localNameLength = readUint16(view, localOffset + 26, 'local name length');
    const localExtraLength = readUint16(view, localOffset + 28, 'local extra length');
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataOffset + compressedSize;
    if (dataEnd > centralOffset) throw new Error('Bundle ZIP local entry exceeds its bounds.');
    const localName = source.subarray(localOffset + 30, localOffset + 30 + localNameLength);
    if (
      readUint16(view, localOffset + 4, 'local required version') !== 20 ||
      localFlags !== flags ||
      localMethod !== method ||
      localModifiedTime !== modifiedTime ||
      localModifiedDate !== modifiedDate ||
      localCrc !== crc ||
      localCompressedSize !== compressedSize ||
      localUncompressedSize !== uncompressedSize ||
      localExtraLength !== 0 ||
      !equalBytes(localName, nameBytes)
    ) {
      throw new Error(`Bundle ZIP headers disagree for ${path}.`);
    }
    const payload = source.subarray(dataOffset, dataEnd);
    if (crc32(payload) !== crc) throw new Error(`Bundle ZIP CRC verification failed for ${path}.`);
    entries.set(path, payload);
    expectedLocalOffset = dataEnd;
    centralCursor = centralEnd;
  }
  if (centralCursor !== eocdOffset || expectedLocalOffset !== centralOffset) {
    throw new Error('Bundle ZIP directory does not cover the archive exactly.');
  }
  return entries;
}

function zipLocalHeader(name: Uint8Array, crc: number, size: number): Uint8Array {
  const header = new Uint8Array(30 + name.length);
  const view = new DataView(header.buffer);
  writeUint32(view, 0, 0x0403_4b50);
  writeUint16(view, 4, 20);
  writeUint16(view, 6, 0x0800);
  writeUint16(view, 8, 0);
  writeUint16(view, 10, 0);
  writeUint16(view, 12, 0x0021);
  writeUint32(view, 14, crc);
  writeUint32(view, 18, size);
  writeUint32(view, 22, size);
  writeUint16(view, 26, name.length);
  writeUint16(view, 28, 0);
  header.set(name, 30);
  return header;
}

function zipCentralEntry(name: Uint8Array, crc: number, size: number, localOffset: number): Uint8Array {
  const entry = new Uint8Array(46 + name.length);
  const view = new DataView(entry.buffer);
  writeUint32(view, 0, 0x0201_4b50);
  writeUint16(view, 4, 20);
  writeUint16(view, 6, 20);
  writeUint16(view, 8, 0x0800);
  writeUint16(view, 10, 0);
  writeUint16(view, 12, 0);
  writeUint16(view, 14, 0x0021);
  writeUint32(view, 16, crc);
  writeUint32(view, 20, size);
  writeUint32(view, 24, size);
  writeUint16(view, 28, name.length);
  writeUint16(view, 30, 0);
  writeUint16(view, 32, 0);
  writeUint16(view, 34, 0);
  writeUint16(view, 36, 0);
  writeUint32(view, 38, 0);
  writeUint32(view, 42, localOffset);
  entry.set(name, 46);
  return entry;
}

function zipEndRecord(entries: number, centralSize: number, centralOffset: number): Uint8Array {
  const record = new Uint8Array(22);
  const view = new DataView(record.buffer);
  writeUint32(view, 0, 0x0605_4b50);
  writeUint16(view, 4, 0);
  writeUint16(view, 6, 0);
  writeUint16(view, 8, entries);
  writeUint16(view, 10, entries);
  writeUint32(view, 12, centralSize);
  writeUint32(view, 16, centralOffset);
  writeUint16(view, 20, 0);
  return record;
}

interface BlobZipEntry {
  path: string;
  name: Uint8Array;
  crc: number;
  size: number;
  part: Blob;
}

/**
 * Canonical stored ZIP32 assembled from Blob parts. Each entry's bytes are
 * handed to the browser's Blob storage as soon as they are added, so an
 * archive of any size needs memory for one entry at a time.
 */
export class StoredZipBlobWriter {
  private readonly entries: BlobZipEntry[] = [];

  /** Adds an entry whose bytes are in memory. */
  add(path: string, bytes: Uint8Array): BlobZipEntry {
    assertArchivePath(path);
    const name = encoder.encode(path);
    if (name.length > 0xffff || bytes.length > UINT32_MAX) {
      throw new Error(`Bundle entry cannot be represented in ZIP32: ${path}`);
    }
    const crc = crc32(bytes);
    return {
      path,
      name,
      crc,
      size: bytes.length,
      part: new Blob([zipLocalHeader(name, crc, bytes.length) as BlobPart, bytes as BlobPart]),
    };
  }

  /** Adds an entry whose bytes are already a Blob; its CRC is computed by streaming. */
  async addBlob(path: string, blob: Blob): Promise<BlobZipEntry> {
    assertArchivePath(path);
    const name = encoder.encode(path);
    if (name.length > 0xffff || blob.size > UINT32_MAX) {
      throw new Error(`Archive entry cannot be represented in ZIP32: ${path}`);
    }
    const crc = await crc32Blob(blob);
    return {
      path,
      name,
      crc,
      size: blob.size,
      part: new Blob([zipLocalHeader(name, crc, blob.size) as BlobPart, blob]),
    };
  }

  /** Appends prepared entries in the order given. */
  push(...entries: BlobZipEntry[]): void {
    this.entries.push(...entries);
  }

  finish(): Blob {
    if (this.entries.length > 0xffff) throw new Error('Archive has too many ZIP entries.');
    const parts: BlobPart[] = [];
    const central: Uint8Array[] = [];
    let offset = 0;
    for (const entry of this.entries) {
      central.push(zipCentralEntry(entry.name, entry.crc, entry.size, offset));
      parts.push(entry.part);
      offset += entry.part.size;
    }
    const centralSize = central.reduce((total, entry) => total + entry.length, 0);
    if (offset + centralSize + 22 > UINT32_MAX) throw new Error('Archive cannot be represented in ZIP32.');
    return new Blob([
      ...parts,
      ...central.map((entry) => entry as BlobPart),
      zipEndRecord(this.entries.length, centralSize, offset) as BlobPart,
    ]);
  }
}

export async function crc32Blob(blob: Blob): Promise<number> {
  let value = 0xffff_ffff;
  const reader = blob.stream().getReader();
  for (;;) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    for (const byte of chunk) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffff_ffff) >>> 0;
}

/**
 * Writes a `.canvink` bundle page by page. The output is byte-identical to
 * `createCanvinkBundle` for the same input, but pages and assets go to Blob
 * storage as they arrive, so exporting a notebook of any size needs memory
 * for one page (or asset) at a time. Pages keep the order they are added in;
 * assets may arrive in any order and are written in canonical SHA-256 order.
 */
export class CanvinkBundleBlobWriter {
  private readonly zip = new StoredZipBlobWriter();
  private readonly schemaVersion: 2 | 3;
  private readonly createdAt: string;
  private readonly generator?: string;
  private notebook?: { id: string; descriptor: CanvinkBundlePayloadDescriptor; entry: BlobZipEntry };
  private readonly pages: Array<{ id: string; descriptor: CanvinkBundlePayloadDescriptor; entry: BlobZipEntry }> = [];
  private readonly pageIds = new Set<string>();
  private readonly assets = new Map<string, {
    mimeType: string;
    size: number;
    originalNames: Set<string>;
    entry: BlobZipEntry;
  }>();

  constructor(options: { schemaVersion?: 2 | 3; createdAt: string; generator?: string }) {
    this.schemaVersion = options.schemaVersion ?? CANVINK_BUNDLE_FORMAT_VERSION;
    this.createdAt = assertTimestamp(options.createdAt);
    this.generator = options.generator === undefined
      ? undefined
      : assertIdentifier(options.generator, 'Bundle generator', 1024);
  }

  async setNotebook(input: CanvinkBundleDocumentInput): Promise<void> {
    const id = assertIdentifier(input.id, 'Notebook ID');
    const bytes = assertBytes(input.bytes, 'Notebook document');
    const mimeType = normalizeMimeType(input.mimeType ?? NOTEBOOK_DOCUMENT_MIME_TYPE, 'Notebook document MIME type');
    this.notebook = {
      id,
      descriptor: descriptor(NOTEBOOK_DOCUMENT_PATH, mimeType, bytes, await sha256(bytes)),
      entry: this.zip.add(NOTEBOOK_DOCUMENT_PATH, bytes),
    };
  }

  async addPage(input: CanvinkBundleDocumentInput): Promise<void> {
    const index = this.pages.length;
    const id = assertIdentifier(input.id, `Page ${index + 1} ID`);
    if (this.pageIds.has(id)) throw new Error(`Duplicate page ID: ${id}`);
    this.pageIds.add(id);
    const bytes = assertBytes(input.bytes, `Page ${index + 1} document`);
    const mimeType = normalizeMimeType(input.mimeType ?? PAGE_DOCUMENT_MIME_TYPE, `Page ${index + 1} document MIME type`);
    const path = `documents/pages/${index.toString().padStart(8, '0')}.bin`;
    this.pages.push({
      id,
      descriptor: descriptor(path, mimeType, bytes, await sha256(bytes)),
      entry: this.zip.add(path, bytes),
    });
  }

  async addAsset(input: CanvinkBundleAssetInput): Promise<void> {
    const index = this.assets.size;
    const bytes = assertBytes(input.bytes, `Asset ${index + 1}`);
    const mimeType = normalizeMimeType(input.mimeType, `Asset ${index + 1} MIME type`);
    const digest = await sha256(bytes);
    const originalName = normalizeOriginalName(input.originalName);
    const existing = this.assets.get(digest);
    if (existing) {
      if (existing.size !== bytes.length) throw new Error('Two different assets produced the same SHA-256 digest.');
      if (existing.mimeType !== mimeType) throw new Error(`Duplicate asset ${digest} has conflicting MIME types.`);
      if (originalName) existing.originalNames.add(originalName);
      return;
    }
    this.assets.set(digest, {
      mimeType,
      size: bytes.length,
      originalNames: new Set(originalName ? [originalName] : []),
      entry: this.zip.add(`assets/${digest}`, bytes),
    });
  }

  finish(): Blob {
    if (!this.notebook) throw new Error('A bundle requires its notebook document.');
    const assets = [...this.assets.entries()].sort(([left], [right]) => compareCanonicalStrings(left, right));
    const manifest: CanvinkBundleManifest = {
      format: CANVINK_BUNDLE_FORMAT,
      formatVersion: this.schemaVersion,
      schemaVersion: this.schemaVersion,
      createdAt: this.createdAt,
      ...(this.generator ? { generator: this.generator } : {}),
      notebook: { id: this.notebook.id, document: this.notebook.descriptor },
      pages: this.pages.map((page) => ({ id: page.id, document: page.descriptor })),
      assets: assets.map(([digest, asset]) => ({
        id: `sha256:${digest}`,
        path: `assets/${digest}`,
        mimeType: asset.mimeType,
        size: asset.size,
        sha256: digest,
        originalNames: [...asset.originalNames].sort(compareCanonicalStrings),
      })),
    };
    this.zip.push(
      this.zip.add(MANIFEST_PATH, encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`)),
      this.notebook.entry,
      ...this.pages.map((page) => page.entry),
      ...assets.map(([, asset]) => asset.entry),
    );
    return this.zip.finish();
  }
}

/** Limits for the Blob reader, which holds one entry in memory at a time. */
export const DEFAULT_CANVINK_BUNDLE_STREAM_LIMITS = Object.freeze({
  ...DEFAULT_CANVINK_BUNDLE_IMPORT_LIMITS,
  maxBundleBytes: UINT32_MAX,
  maxTotalUncompressedBytes: UINT32_MAX,
}) satisfies Readonly<CanvinkBundleImportLimits>;

interface BlobZipDirectoryEntry {
  path: string;
  dataOffset: number;
  size: number;
  crc: number;
}

/** A verified bundle whose payloads are read (and verified) one at a time. */
export interface OpenedCanvinkBundle {
  manifest: CanvinkBundleManifest;
  readNotebook(): Promise<ImportedCanvinkDocument>;
  readPage(index: number): Promise<ImportedCanvinkDocument>;
  readAsset(index: number): Promise<ImportedCanvinkAsset>;
}

async function readBlobRange(blob: Blob, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

/**
 * Opens a bundle from a Blob or File without reading its payloads: the ZIP
 * directory and manifest are checked like `readCanvinkBundle` does, and each
 * page or asset is read and verified (size, CRC, SHA-256) when requested.
 */
export async function openCanvinkBundle(
  blob: Blob,
  limitOverrides: Partial<CanvinkBundleImportLimits> = {},
): Promise<OpenedCanvinkBundle> {
  const limits = resolveLimits({ ...DEFAULT_CANVINK_BUNDLE_STREAM_LIMITS, ...limitOverrides });
  if (blob.size < 22 || blob.size > limits.maxBundleBytes) {
    throw new Error(`Bundle must be between 22 bytes and ${limits.maxBundleBytes} bytes.`);
  }
  const eocdOffset = blob.size - 22;
  const end = await readBlobRange(blob, eocdOffset, blob.size);
  const endView = new DataView(end.buffer);
  if (
    readUint32(endView, 0, 'end record') !== 0x0605_4b50
    || readUint16(endView, 4, 'disk number') !== 0
    || readUint16(endView, 6, 'central disk') !== 0
    || readUint16(endView, 20, 'comment length') !== 0
  ) throw new Error('Bundle does not have a canonical ZIP end record.');
  const totalEntries = readUint16(endView, 10, 'entry count');
  if (readUint16(endView, 8, 'disk entry count') !== totalEntries) throw new Error('ZIP entry counts do not match.');
  if (totalEntries < 2 || totalEntries > limits.maxEntries) {
    throw new Error('Bundle ZIP entry count is outside the configured import limit.');
  }
  const centralSize = readUint32(endView, 12, 'central size');
  const centralOffset = readUint32(endView, 16, 'central offset');
  if (centralOffset + centralSize !== eocdOffset) throw new Error('Bundle ZIP central directory bounds are invalid.');
  const central = await readBlobRange(blob, centralOffset, eocdOffset);
  const view = new DataView(central.buffer);
  const entries = new Map<string, BlobZipDirectoryEntry>();
  let cursor = 0;
  let expectedLocalOffset = 0;
  let totalUncompressed = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    if (readUint32(view, cursor, 'central header') !== 0x0201_4b50) throw new Error('Bundle ZIP central directory is malformed.');
    const flags = readUint16(view, cursor + 8, 'central flags');
    const method = readUint16(view, cursor + 10, 'central method');
    const crc = readUint32(view, cursor + 16, 'central CRC');
    const compressedSize = readUint32(view, cursor + 20, 'central compressed size');
    const uncompressedSize = readUint32(view, cursor + 24, 'central uncompressed size');
    const nameLength = readUint16(view, cursor + 28, 'central name length');
    const extraLength = readUint16(view, cursor + 30, 'central extra length');
    const commentLength = readUint16(view, cursor + 32, 'central comment length');
    const localOffset = readUint32(view, cursor + 42, 'local offset');
    if (
      readUint16(view, cursor + 4, 'creator version') !== 20
      || readUint16(view, cursor + 6, 'required version') !== 20
      || flags !== 0x0800
      || method !== 0
      || readUint16(view, cursor + 12, 'central modified time') !== 0
      || readUint16(view, cursor + 14, 'central modified date') !== 0x0021
      || extraLength !== 0
      || commentLength !== 0
      || readUint16(view, cursor + 34, 'central disk start') !== 0
      || readUint16(view, cursor + 36, 'internal attributes') !== 0
      || readUint32(view, cursor + 38, 'external attributes') !== 0
      || compressedSize !== uncompressedSize
    ) throw new Error('Bundle entries must use the canonical uncompressed ZIP32 profile.');
    totalUncompressed += uncompressedSize;
    if (!Number.isSafeInteger(totalUncompressed) || totalUncompressed > limits.maxTotalUncompressedBytes) {
      throw new Error('Bundle exceeds the total uncompressed import limit.');
    }
    const nameBytes = central.subarray(cursor + 46, cursor + 46 + nameLength);
    let path: string;
    try {
      path = strictDecoder.decode(nameBytes);
    } catch (error) {
      throw new Error('Bundle contains an invalid UTF-8 ZIP path.', { cause: error });
    }
    assertArchivePath(path);
    if (entries.has(path)) throw new Error(`Bundle contains a duplicate ZIP path: ${path}.`);
    const entryLimit = path === MANIFEST_PATH
      ? limits.maxManifestBytes
      : path.startsWith('documents/') ? limits.maxDocumentBytes : limits.maxAssetBytes;
    if (uncompressedSize > entryLimit) throw new Error(`${path} exceeds its configured ZIP entry import limit.`);
    if (localOffset !== expectedLocalOffset) {
      throw new Error('Bundle ZIP local entries are overlapping, reordered, or contain gaps.');
    }
    const local = await readBlobRange(blob, localOffset, localOffset + 30 + nameLength);
    const localView = new DataView(local.buffer);
    if (
      readUint32(localView, 0, 'local header') !== 0x0403_4b50
      || readUint16(localView, 4, 'local required version') !== 20
      || readUint16(localView, 6, 'local flags') !== flags
      || readUint16(localView, 8, 'local method') !== method
      || readUint32(localView, 14, 'local CRC') !== crc
      || readUint32(localView, 18, 'local compressed size') !== compressedSize
      || readUint32(localView, 22, 'local uncompressed size') !== uncompressedSize
      || readUint16(localView, 26, 'local name length') !== nameLength
      || readUint16(localView, 28, 'local extra length') !== 0
      || !equalBytes(local.subarray(30), nameBytes)
    ) throw new Error(`Bundle ZIP headers disagree for ${path}.`);
    const dataOffset = localOffset + 30 + nameLength;
    const dataEnd = dataOffset + compressedSize;
    if (dataEnd > centralOffset) throw new Error('Bundle ZIP local entry exceeds its bounds.');
    entries.set(path, { path, dataOffset, size: uncompressedSize, crc });
    expectedLocalOffset = dataEnd;
    cursor += 46 + nameLength;
  }
  if (cursor !== central.length || expectedLocalOffset !== centralOffset) {
    throw new Error('Bundle ZIP directory does not cover the archive exactly.');
  }
  const readEntry = async (path: string): Promise<Uint8Array> => {
    const entry = entries.get(path);
    if (!entry) throw new Error(`Bundle is missing ${path}.`);
    const bytes = await readBlobRange(blob, entry.dataOffset, entry.dataOffset + entry.size);
    if (bytes.length !== entry.size || crc32(bytes) !== entry.crc) {
      throw new Error(`Bundle ZIP CRC verification failed for ${path}.`);
    }
    return bytes;
  };
  const manifestBytes = await readEntry(MANIFEST_PATH);
  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(strictDecoder.decode(manifestBytes));
  } catch (error) {
    throw new Error('Bundle manifest is not valid UTF-8 JSON.', { cause: error });
  }
  const manifest = validateManifest(rawManifest, limits);
  const expectedArchivePaths = [
    MANIFEST_PATH,
    manifest.notebook.document.path,
    ...manifest.pages.map((page) => page.document.path),
    ...manifest.assets.map((asset) => asset.path),
  ];
  const archivePaths = [...entries.keys()];
  if (
    archivePaths.length !== expectedArchivePaths.length
    || archivePaths.some((path, index) => path !== expectedArchivePaths[index])
  ) throw new Error('Bundle entries are missing, unreferenced, or not in canonical order.');
  const readPayload = async (payload: CanvinkBundlePayloadDescriptor): Promise<Uint8Array> => {
    const bytes = await readEntry(payload.path);
    if (bytes.length !== payload.size) throw new Error(`${payload.path} size does not match its manifest entry.`);
    if (await sha256(bytes) !== payload.sha256) throw new Error(`${payload.path} failed SHA-256 verification.`);
    return bytes;
  };
  return {
    manifest,
    readNotebook: async () => ({
      id: manifest.notebook.id,
      bytes: await readPayload(manifest.notebook.document),
      mimeType: manifest.notebook.document.mimeType,
      sha256: manifest.notebook.document.sha256,
    }),
    readPage: async (index) => {
      const page = manifest.pages[index];
      if (!page) throw new Error(`Bundle has no page ${index + 1}.`);
      return {
        id: page.id,
        bytes: await readPayload(page.document),
        mimeType: page.document.mimeType,
        sha256: page.document.sha256,
      };
    },
    readAsset: async (index) => {
      const asset = manifest.assets[index];
      if (!asset) throw new Error(`Bundle has no asset ${index + 1}.`);
      return {
        id: asset.id,
        bytes: await readPayload(asset),
        mimeType: asset.mimeType,
        sha256: asset.sha256,
        originalNames: [...asset.originalNames],
      };
    },
  };
}
