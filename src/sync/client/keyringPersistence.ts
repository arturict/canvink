import {
  generateNotebookKey,
  NOTEBOOK_KEY_BYTES,
  NotebookKeyring,
  type NotebookEpochKey,
} from '../crypto';
import { SyncClientError } from './errors';
import type { DeviceSeedSecretStore } from './cryptoAdapter';

const MAGIC = new TextEncoder().encode('CVNKRG1');
const MAX_EPOCHS = 4_096;
const RECORD_BYTES = 4 + NOTEBOOK_KEY_BYTES;

export interface NotebookKeyringPort {
  readonly notebookId: string;
  readonly currentEpoch: number;
  currentKey(): NotebookEpochKey;
  keyForEpoch(epoch: number): NotebookEpochKey;
  install(value: NotebookEpochKey): Promise<void>;
  rotate(): Promise<NotebookEpochKey>;
  toJSON(): { notebookId: string; currentEpoch: number; availableEpochs: number[] };
  destroy(): Promise<void>;
}

export class ProtectedNotebookKeyring implements NotebookKeyringPort {
  private constructor(
    private readonly inner: NotebookKeyring,
    private readonly store: DeviceSeedSecretStore,
    private readonly storageId: string,
  ) {}

  static async load(notebookId: string, store: DeviceSeedSecretStore): Promise<ProtectedNotebookKeyring | undefined> {
    const storageId = keyringStorageId(notebookId);
    const protectedBytes = await store.load(storageId);
    if (!protectedBytes) return undefined;
    try {
      const epochs = decodeKeyring(notebookId, protectedBytes);
      const inner = new NotebookKeyring(epochs[0]);
      for (const epoch of epochs.slice(1)) await inner.install(epoch);
      return new ProtectedNotebookKeyring(inner, store, storageId);
    } finally {
      protectedBytes.fill(0);
    }
  }

  static async create(notebookId: string, store: DeviceSeedSecretStore, initial?: NotebookEpochKey): Promise<ProtectedNotebookKeyring> {
    const existing = await store.load(keyringStorageId(notebookId));
    if (existing) {
      existing.fill(0);
      throw new SyncClientError('protocol-error', 'A protected notebook keyring already exists.');
    }
    const key = initial ?? await generateNotebookKey(notebookId, 1);
    if (key.notebookId !== notebookId) throw new SyncClientError('protocol-error', 'Initial notebook key belongs to another notebook.');
    const result = new ProtectedNotebookKeyring(new NotebookKeyring(key), store, keyringStorageId(notebookId));
    await result.persist();
    return result;
  }

  get notebookId(): string { return this.inner.notebookId; }
  get currentEpoch(): number { return this.inner.currentEpoch; }
  currentKey(): NotebookEpochKey { return this.inner.currentKey(); }
  keyForEpoch(epoch: number): NotebookEpochKey { return this.inner.keyForEpoch(epoch); }

  async install(value: NotebookEpochKey): Promise<void> {
    await this.inner.install(value);
    await this.persist();
  }

  async rotate(): Promise<NotebookEpochKey> {
    const key = await generateNotebookKey(this.notebookId, this.currentEpoch + 1);
    await this.persist(key);
    await this.inner.install(key);
    return key;
  }

  toJSON() { return this.inner.toJSON(); }
  destroy(): Promise<void> { return this.inner.destroy(); }

  private async persist(additional?: NotebookEpochKey): Promise<void> {
    const metadata = this.inner.toJSON();
    const epochs = [...new Set([
      ...metadata.availableEpochs,
      ...(additional ? [additional.epoch] : []),
    ])].sort((left, right) => left - right);
    if (epochs.length < 1 || epochs.length > MAX_EPOCHS) {
      throw new SyncClientError('key-epoch-unavailable', 'Notebook keyring epoch count is invalid.');
    }
    const bytes = new Uint8Array(MAGIC.byteLength + 2 + epochs.length * RECORD_BYTES);
    bytes.set(MAGIC);
    const view = new DataView(bytes.buffer);
    view.setUint16(MAGIC.byteLength, epochs.length, false);
    let offset = MAGIC.byteLength + 2;
    const copies: Uint8Array[] = [];
    try {
      for (const epoch of epochs) {
        if (!Number.isSafeInteger(epoch) || epoch < 1 || epoch > 0xffff_ffff) throw new SyncClientError('key-epoch-unavailable', 'Notebook keyring epoch is invalid.');
        const key = additional?.epoch === epoch ? additional.key.slice() : this.inner.keyForEpoch(epoch).key;
        copies.push(key);
        view.setUint32(offset, epoch, false);
        bytes.set(key, offset + 4);
        offset += RECORD_BYTES;
      }
      await this.store.save(this.storageId, bytes);
    } catch (error) {
      throw error instanceof SyncClientError ? error : new SyncClientError('key-epoch-unavailable', 'Notebook keyring could not be protected at rest.', { cause: error });
    } finally {
      bytes.fill(0);
      for (const copy of copies) copy.fill(0);
    }
  }
}

function decodeKeyring(notebookId: string, bytes: Uint8Array): NotebookEpochKey[] {
  if (bytes.byteLength < MAGIC.byteLength + 2 || !MAGIC.every((byte, index) => bytes[index] === byte)) {
    throw new SyncClientError('key-epoch-unavailable', 'Protected notebook keyring is invalid.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(MAGIC.byteLength, false);
  if (count < 1 || count > MAX_EPOCHS || bytes.byteLength !== MAGIC.byteLength + 2 + count * RECORD_BYTES) {
    throw new SyncClientError('key-epoch-unavailable', 'Protected notebook keyring is invalid.');
  }
  const result: NotebookEpochKey[] = [];
  let previous = 0;
  let offset = MAGIC.byteLength + 2;
  for (let index = 0; index < count; index += 1) {
    const epoch = view.getUint32(offset, false);
    if (epoch <= previous) throw new SyncClientError('key-epoch-unavailable', 'Protected notebook epochs are not canonical.');
    result.push({ notebookId, epoch, key: bytes.slice(offset + 4, offset + RECORD_BYTES) });
    previous = epoch;
    offset += RECORD_BYTES;
  }
  return result;
}

function keyringStorageId(notebookId: string): string { return `notebook-keyring:${notebookId}`; }
