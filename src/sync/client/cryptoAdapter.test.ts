import { describe, expect, it, vi } from 'vitest';
import { createDeviceIdentity, generateNotebookKey, NotebookKeyring } from '../crypto';
import { loadOrCreateProtectedDeviceIdentity, NotebookCryptoAdapter } from './cryptoAdapter';
import { createNotebookDeviceResolver } from './runtime';
import type { SyncDeviceDirectoryPort } from './types';

const bytes = (length: number, fill: number) => new Uint8Array(length).fill(fill);

describe('production crypto adapter', () => {
  it('restores identical device public keys from a protected seed store without exposing raw keys', async () => {
    let protectedValue: Uint8Array | undefined;
    const store = {
      load: vi.fn(async () => protectedValue?.slice()),
      save: vi.fn(async (_id: string, value: Uint8Array) => { protectedValue = value.slice(); value.fill(0); }),
      clear: vi.fn(),
    };
    const first = await loadOrCreateProtectedDeviceIdentity({ accountId: 'account', deviceId: 'device', store });
    const second = await loadOrCreateProtectedDeviceIdentity({ accountId: 'account', deviceId: 'device', store });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.identity.publicIdentity).toEqual(first.identity.publicIdentity);
    expect(protectedValue).toHaveLength(68);
  });

  it('encrypts and verifies changes through the keyring and authenticated sender directory', async () => {
    const sender = await createDeviceIdentity({ accountId: 'account', deviceId: 'device', encryptionSeed: bytes(32, 8), signingSeed: bytes(32, 9) });
    const keyring = new NotebookKeyring(await generateNotebookKey('notebook', 1));
    const adapter = new NotebookCryptoAdapter({ notebookId: 'notebook', identity: sender, keyring, resolveSender: async () => sender.publicIdentity });
    const pending = await adapter.encryptChange('page:1', bytes(12, 7));
    await expect(adapter.decryptChange({ ...pending, sequence: 1 })).resolves.toEqual(bytes(12, 7));
  });

  it('resolves only active collaborator signing keys from the notebook-scoped directory', async () => {
    const directory = {
      listNotebookDevices: vi.fn(async () => ({ devices: [{
        protocolVersion: 1 as const, deviceId: 'collaborator-device', encryptionPublicKey: bytes(32, 4), signingPublicKey: bytes(32, 5), status: 'active' as const,
        createdAt: '2026-08-03T12:00:00.000Z', updatedAt: '2026-08-03T12:00:00.000Z',
      }] })),
    } as unknown as SyncDeviceDirectoryPort;
    const resolve = createNotebookDeviceResolver(directory, 'notebook');
    await expect(resolve('collaborator-device')).resolves.toMatchObject({ deviceId: 'collaborator-device', signingPublicKey: bytes(32, 5) });
    await expect(resolve('revoked-device')).rejects.toMatchObject({ code: 'protocol-error' });
  });
});
