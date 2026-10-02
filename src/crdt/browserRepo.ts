import { Repo, type StorageAdapterInterface } from '@automerge/automerge-repo';
import {
  CanvinkStorageAdapter,
  type CanvinkStorageAdapterOptions,
} from './canvinkStorageAdapter';

export interface BrowserAutomergeRepoOptions extends CanvinkStorageAdapterOptions {
  /** Injectable for tests and the Tauri bridge; defaults to Canvink IndexedDB storage. */
  storage?: StorageAdapterInterface;
}

/**
 * Creates a local browser repository backed by IndexedDB. No network adapter is
 * installed, so this factory does not imply peer discovery or remote sync.
 */
export function createBrowserAutomergeRepo(
  options: BrowserAutomergeRepoOptions = {},
): Repo {
  if (typeof indexedDB === 'undefined') {
    throw new Error('IndexedDB is required to create the browser Automerge repository.');
  }
  const storage = options.storage ?? new CanvinkStorageAdapter({
    ...options,
    databaseName: options.databaseName ?? 'canvink-v2',
    objectStoreName: options.objectStoreName ?? 'documents-assets',
    // The activation store and Repo chunks intentionally share this existing
    // object store, so no IndexedDB version upgrade is required at runtime.
    databaseVersion: options.databaseVersion ?? 1,
    namespace: options.namespace ?? ['automerge-repo'],
  });
  return new Repo({ storage, network: [], isEphemeral: false });
}
