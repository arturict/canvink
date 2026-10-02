import type { DevicePublicIdentity, SyncEnvelope } from '../types';
import {
  createDeviceIdentity,
  encryptChange,
  type DeviceSecretIdentity,
  type NotebookEpochKey,
  verifyAndDecryptChange,
} from '../crypto';
import { SyncClientError } from './errors';
import type { SyncCryptoPort } from './types';
import type { NotebookKeyringPort } from './keyringPersistence';

export interface DeviceSeedSecretStore {
  load(id: string): Uint8Array | undefined | Promise<Uint8Array | undefined>;
  save(id: string, secret: Uint8Array): void | Promise<void>;
  clear(id: string): void | Promise<void>;
}

export interface NotebookCryptoAdapterOptions {
  notebookId: string;
  identity: DeviceSecretIdentity;
  keyring: NotebookKeyringPort;
  resolveSender(deviceId: string): Promise<DevicePublicIdentity>;
  loadKeyEpoch?(epoch: number, signal: AbortSignal): Promise<NotebookEpochKey | undefined>;
}

/** Production crypto port over the independently tested protocol primitives. */
export class NotebookCryptoAdapter implements SyncCryptoPort {
  constructor(private readonly options: NotebookCryptoAdapterOptions) {}

  encryptChange(documentId: string, plaintext: Uint8Array) {
    return encryptChange({
      notebookId: this.options.notebookId,
      documentId,
      plaintext,
      notebookKey: this.options.keyring.currentKey(),
      sender: this.options.identity,
    });
  }

  async decryptChange(envelope: SyncEnvelope): Promise<Uint8Array> {
    if (envelope.notebookId !== this.options.notebookId) throw new SyncClientError('protocol-error', 'Encrypted change belongs to another notebook.');
    const sender = await this.options.resolveSender(envelope.deviceId);
    return verifyAndDecryptChange({
      envelope,
      notebookKey: this.options.keyring.keyForEpoch(envelope.keyEpoch),
      sender,
    });
  }

  currentKeyEpoch(): number { return this.options.keyring.currentEpoch; }

  async awaitKeyEpoch(epoch: number, signal: AbortSignal): Promise<void> {
    try {
      this.options.keyring.keyForEpoch(epoch);
      return;
    } catch {
      // The authenticated key-envelope loader is the only fallback.
    }
    if (signal.aborted) throw new SyncClientError('aborted', 'Sync was cancelled.');
    const loaded = await this.options.loadKeyEpoch?.(epoch, signal);
    if (!loaded || loaded.notebookId !== this.options.notebookId || loaded.epoch !== epoch) {
      throw new SyncClientError('key-epoch-unavailable', 'The required notebook key epoch is unavailable.');
    }
    await this.options.keyring.install(loaded);
  }
}

const SEED_MAGIC = new TextEncoder().encode('CVS1');
const DEVICE_SEED_BYTES = 64;

/** Creates or restores a device while storing only its random seeds via the selected protected store. */
export async function loadOrCreateProtectedDeviceIdentity(input: {
  accountId: string;
  deviceId: string;
  store: DeviceSeedSecretStore;
}): Promise<{ identity: DeviceSecretIdentity; created: boolean }> {
  const storageId = `device-seeds:${input.accountId}:${input.deviceId}`;
  const stored = await input.store.load(storageId);
  if (stored) {
    try {
      const seeds = unpackSeeds(stored);
      return {
        identity: await createDeviceIdentity({
          accountId: input.accountId,
          deviceId: input.deviceId,
          encryptionSeed: seeds.encryptionSeed,
          signingSeed: seeds.signingSeed,
        }),
        created: false,
      };
    } finally {
      stored.fill(0);
    }
  }
  if (!globalThis.crypto?.getRandomValues) throw new SyncClientError('key-epoch-unavailable', 'Secure device randomness is unavailable.');
  const encryptionSeed = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const signingSeed = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const identity = await createDeviceIdentity({
    accountId: input.accountId,
    deviceId: input.deviceId,
    encryptionSeed: encryptionSeed.slice(),
    signingSeed: signingSeed.slice(),
  });
  const packed = new Uint8Array(SEED_MAGIC.byteLength + DEVICE_SEED_BYTES);
  packed.set(SEED_MAGIC);
  packed.set(encryptionSeed, SEED_MAGIC.byteLength);
  packed.set(signingSeed, SEED_MAGIC.byteLength + 32);
  encryptionSeed.fill(0);
  signingSeed.fill(0);
  try {
    await input.store.save(storageId, packed);
  } catch (error) {
    packed.fill(0);
    throw new SyncClientError('key-epoch-unavailable', 'Device identity could not be protected at rest.', { cause: error });
  }
  return { identity, created: true };
}

function unpackSeeds(value: Uint8Array): { encryptionSeed: Uint8Array; signingSeed: Uint8Array } {
  if (value.byteLength !== SEED_MAGIC.byteLength + DEVICE_SEED_BYTES || !SEED_MAGIC.every((byte, index) => value[index] === byte)) {
    throw new SyncClientError('key-epoch-unavailable', 'Protected device identity is invalid.');
  }
  return {
    encryptionSeed: value.slice(SEED_MAGIC.byteLength, SEED_MAGIC.byteLength + 32),
    signingSeed: value.slice(SEED_MAGIC.byteLength + 32),
  };
}
