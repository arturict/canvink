import { describe, expect, it } from 'vitest';
import type { WorkspaceState } from '../domain/types';
import { prepareV1ToV2Migration } from '../domain/v2/migration';
import type { AtomicKeyValueStore, AtomicStorageKey } from './browserAssetStore';
import { BrowserAssetStore } from './browserAssetStore';

const TIME = '2026-08-03T08:00:00.000Z';

class MemoryAtomicStore implements AtomicKeyValueStore {
  readonly values = new Map<string, unknown>();
  failNextCommit = false;

  private key(key: AtomicStorageKey): string {
    return typeof key === 'string' ? key : `array:${JSON.stringify(key)}`;
  }

  async get<T>(key: AtomicStorageKey): Promise<T | undefined> {
    return this.values.get(this.key(key)) as T | undefined;
  }

  async setMany(entries: Array<readonly [AtomicStorageKey, unknown]>): Promise<void> {
    if (this.failNextCommit) {
      this.failNextCommit = false;
      throw new Error('simulated transaction abort');
    }
    const transaction = new Map(this.values);
    for (const [key, value] of entries) transaction.set(this.key(key), structuredClone(value));
    this.values.clear();
    for (const [key, value] of transaction) this.values.set(key, value);
  }
}

function workspace(title = 'Notebook'): WorkspaceState {
  return {
    schemaVersion: 1,
    updatedAt: TIME,
    notebooks: [
      {
        id: 'notebook-1',
        title,
        color: '#123456',
        createdAt: TIME,
        updatedAt: TIME,
        sections: [
          {
            id: 'section-1',
            title: 'Section',
            createdAt: TIME,
            updatedAt: TIME,
            pages: [
              {
                id: 'page-1',
                title: 'Page',
                mode: 'free',
                createdAt: TIME,
                updatedAt: TIME,
                elements: [
                  {
                    id: 'image-1',
                    kind: 'image',
                    x: 0,
                    y: 0,
                    width: 20,
                    height: 20,
                    dataUrl: 'data:image/png;base64,SGVsbG8=',
                    name: 'image.png',
                    alt: '',
                    createdAt: TIME,
                    updatedAt: TIME,
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
    trash: [],
    activeNotebookId: 'notebook-1',
    activeSectionId: 'section-1',
    activePageId: 'page-1',
  };
}

describe('BrowserAssetStore', () => {
  it('atomically stores documents, assets, manifest, and the migration marker', async () => {
    const adapter = new MemoryAtomicStore();
    const repository = new BrowserAssetStore(adapter, () => TIME);
    const result = await prepareV1ToV2Migration(workspace());

    await expect(repository.commitMigration(result)).resolves.toMatchObject({ status: 'committed' });
    await expect(repository.getManifest()).resolves.toEqual(result.manifest);
    await expect(repository.getAsset(result.assets[0].assetId)).resolves.toEqual(result.assets[0]);
    const document = await repository.getDocument('page:page-1');
    expect(document).toMatchObject({
      documentFormat: 'canvink-json-v2',
      encoding: 'utf8-json',
      version: { protocol: 'uninitialized', heads: [] },
    });
    expect(new TextDecoder().decode(document?.bytes)).toContain('"kind":"page"');
  });

  it('is idempotent for the same migration and rejects a different source', async () => {
    const adapter = new MemoryAtomicStore();
    const repository = new BrowserAssetStore(adapter, () => TIME);
    const first = await prepareV1ToV2Migration(workspace());
    await repository.commitMigration(first);
    const sizeAfterFirstCommit = adapter.values.size;

    await expect(repository.commitMigration(first)).resolves.toMatchObject({
      status: 'already-committed',
    });
    expect(adapter.values.size).toBe(sizeAfterFirstCommit);

    const different = await prepareV1ToV2Migration(workspace('Changed'));
    await expect(repository.commitMigration(different)).rejects.toThrow(/different.*already committed/i);
  });

  it('does not expose a marker or partial records when the transaction aborts', async () => {
    const adapter = new MemoryAtomicStore();
    adapter.failNextCommit = true;
    const repository = new BrowserAssetStore(adapter, () => TIME);
    const result = await prepareV1ToV2Migration(workspace());

    await expect(repository.commitMigration(result)).rejects.toThrow(/transaction abort/i);
    await expect(repository.getMigrationMarker()).resolves.toBeUndefined();
    expect(adapter.values.size).toBe(0);
  });
});
