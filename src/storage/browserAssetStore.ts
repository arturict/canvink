import { createStore, get, setMany } from 'idb-keyval';
import { canonicalJson, sha256Bytes } from '../domain/v2/hash';
import { verifyMigrationResult } from '../domain/v2/migration';
import type {
  AssetBlob,
  MigrationManifestV2,
  MigrationResultV2,
  Sha256Checksum,
  StoredDocumentV2,
} from '../domain/v2/types';

const DATABASE_NAME = 'canvink-v2';
const STORE_NAME = 'documents-assets';
const MARKER_KEY = 'migration:v1-to-v2:committed';
const MANIFEST_KEY = 'manifest:current';

export interface MigrationMarkerV2 {
  migrationId: string;
  sourceFingerprint: Sha256Checksum;
  artifactFingerprint: Sha256Checksum;
  committedAt: string;
}

export type AtomicStorageKey = string | readonly string[];

export function atomicStorageIdbKey(key: AtomicStorageKey): IDBValidKey {
  return typeof key === 'string' ? key : [...key];
}

export interface AtomicKeyValueStore {
  get<T>(key: AtomicStorageKey): Promise<T | undefined>;
  /** Implementations must commit every entry, including the marker, in one transaction. */
  setMany(entries: Array<readonly [AtomicStorageKey, unknown]>): Promise<void>;
  /**
   * Optional atomic replace primitive used when a complete Repo image removes
   * stale chunks, and by delta commits, which also remove every key under
   * each of `removedPrefixes` (array keys only, compared segment by segment).
   */
  replaceMany?(
    entries: Array<readonly [AtomicStorageKey, unknown]>,
    removedKeys: readonly AtomicStorageKey[],
    removedPrefixes?: ReadonlyArray<readonly string[]>,
  ): Promise<void>;
}

export interface BrowserDocumentAssetRepository {
  getMigrationMarker(): Promise<MigrationMarkerV2 | undefined>;
  getManifest(): Promise<MigrationManifestV2 | undefined>;
  getDocument(documentId: string): Promise<StoredDocumentV2 | undefined>;
  getAsset(assetId: Sha256Checksum): Promise<AssetBlob | undefined>;
  commitMigration(result: MigrationResultV2): Promise<{
    status: 'committed' | 'already-committed';
    marker: MigrationMarkerV2;
  }>;
}

class IndexedDbAtomicStore implements AtomicKeyValueStore {
  private readonly store = createStore(DATABASE_NAME, STORE_NAME);

  get<T>(key: AtomicStorageKey): Promise<T | undefined> {
    return get<T>(atomicStorageIdbKey(key), this.store);
  }

  setMany(entries: Array<readonly [AtomicStorageKey, unknown]>): Promise<void> {
    return setMany(
      entries.map(([key, value]) => [atomicStorageIdbKey(key), value]),
      this.store,
    );
  }
}

function assetKey(assetId: Sha256Checksum): string {
  return `asset:${assetId}`;
}

function documentKey(documentId: string): string {
  return `document:${documentId}`;
}

function storedDocument(result: MigrationResultV2, index: number): StoredDocumentV2 {
  const document = result.documents[index];
  return {
    documentId: document.documentId,
    kind: document.kind,
    schemaVersion: document.schemaVersion,
    documentFormat: 'canvink-json-v2',
    encoding: 'utf8-json',
    version: structuredClone(document.version),
    bytes: new TextEncoder().encode(canonicalJson(document)),
  };
}

function sameMigration(left: MigrationMarkerV2, right: MigrationMarkerV2): boolean {
  return (
    left.migrationId === right.migrationId &&
    left.sourceFingerprint === right.sourceFingerprint &&
    left.artifactFingerprint === right.artifactFingerprint
  );
}

export class BrowserAssetStore implements BrowserDocumentAssetRepository {
  constructor(
    private readonly adapter: AtomicKeyValueStore = new IndexedDbAtomicStore(),
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  getMigrationMarker(): Promise<MigrationMarkerV2 | undefined> {
    return this.adapter.get<MigrationMarkerV2>(MARKER_KEY);
  }

  getManifest(): Promise<MigrationManifestV2 | undefined> {
    return this.adapter.get<MigrationManifestV2>(MANIFEST_KEY);
  }

  getDocument(documentId: string): Promise<StoredDocumentV2 | undefined> {
    return this.adapter.get<StoredDocumentV2>(documentKey(documentId));
  }

  async getAsset(assetId: Sha256Checksum): Promise<AssetBlob | undefined> {
    const asset = await this.adapter.get<AssetBlob>(assetKey(assetId));
    if (!asset) return undefined;
    const checksum = await sha256Bytes(asset.bytes);
    if (
      checksum !== assetId ||
      asset.checksum !== assetId ||
      asset.size !== asset.bytes.byteLength
    ) {
      throw new Error(`Stored asset ${assetId} failed integrity verification.`);
    }
    return asset;
  }

  async commitMigration(result: MigrationResultV2): Promise<{
    status: 'committed' | 'already-committed';
    marker: MigrationMarkerV2;
  }> {
    await verifyMigrationResult(result);
    const marker: MigrationMarkerV2 = {
      migrationId: result.manifest.migration.migrationId,
      sourceFingerprint: result.manifest.migration.sourceFingerprint,
      artifactFingerprint: result.artifactFingerprint,
      committedAt: this.now(),
    };
    const existing = await this.getMigrationMarker();
    if (existing) {
      if (!sameMigration(existing, marker)) {
        throw new Error('A different schema-v2 migration is already committed. Existing data was not changed.');
      }
      return { status: 'already-committed', marker: existing };
    }

    const entries: Array<readonly [string, unknown]> = [];
    result.assets.forEach((asset) => entries.push([assetKey(asset.assetId), structuredClone(asset)]));
    result.documents.forEach((document, index) =>
      entries.push([documentKey(document.documentId), storedDocument(result, index)]),
    );
    entries.push([MANIFEST_KEY, structuredClone(result.manifest)]);
    // The marker participates in the same transaction and is intentionally the final entry.
    entries.push([MARKER_KEY, marker]);
    await this.adapter.setMany(entries);

    const committed = await this.getMigrationMarker();
    if (!committed || !sameMigration(committed, marker)) {
      throw new Error('Schema-v2 migration storage did not confirm its atomic commit marker.');
    }
    return { status: 'committed', marker: committed };
  }
}
