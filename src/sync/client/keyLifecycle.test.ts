import { describe, expect, it, vi } from 'vitest';
import {
  createDeviceApprovalChallenge,
  createDeviceIdentity,
  destroyRecoverySecret,
  parseRecoveryCode,
  verifyRecoveryDeviceActivationProof,
  type RecoveryPublicIdentity,
} from '../crypto';
import type { NotebookKeyEnvelope } from '../types';
import type { AppwriteSyncServices } from './appwrite';
import {
  AppwriteNotebookSecurityUi,
  initializeOwnerNotebookKeys,
  recoverAndActivateDevice,
  rotateAndRedistributeNotebookKey,
} from './keyLifecycle';
import type { DeviceSeedSecretStore } from './cryptoAdapter';
import type { SyncRegisteredDevice, SyncStoredKeyEnvelope } from './types';

const bytes = (length: number, fill: number) => new Uint8Array(length).fill(fill);

describe('notebook key lifecycle composition', () => {
  it('persists rotation, redistributes after device loss, and recovers historical/current epochs on a new device', async () => {
    const owner = await createDeviceIdentity({ accountId: 'owner-account', deviceId: 'owner-device', encryptionSeed: bytes(32, 1), signingSeed: bytes(32, 2) });
    const lost = await createDeviceIdentity({ accountId: 'owner-account', deviceId: 'lost-device', encryptionSeed: bytes(32, 3), signingSeed: bytes(32, 4) });
    const replacement = await createDeviceIdentity({ accountId: 'owner-account', deviceId: 'replacement-device', encryptionSeed: bytes(32, 5), signingSeed: bytes(32, 6) });
    const ownerStore = memorySecretStore();
    const replacementStore = memorySecretStore();
    const stored: SyncStoredKeyEnvelope[] = [];
    let activeDevices = [registered(owner), registered(lost)];
    let activationChallenge: Awaited<ReturnType<typeof createDeviceApprovalChallenge>> | undefined;
    const recoveryPublic: { current?: RecoveryPublicIdentity } = {};

    const directory = {
      listNotebookDevices: async () => ({ devices: activeDevices }),
      listKeyEnvelopes: async (input: { recipient: { kind: string; id: string } }) => ({
        envelopes: stored.filter(({ envelope }) => recipientMatches(envelope, input.recipient)),
      }),
      revokeDevice: vi.fn(async ({ deviceId }: { deviceId: string }) => {
        activeDevices = activeDevices.filter((device) => device.deviceId !== deviceId);
        return { device: { ...registered(lost), status: 'revoked' as const }, duplicate: false };
      }),
      createDeviceApprovalChallenge: async () => {
        activationChallenge = await createDeviceApprovalChallenge({ notebookId: 'notebook', requestingDevice: replacement.publicIdentity });
        return { challengeId: 'recovery-challenge', challenge: activationChallenge };
      },
      activateDeviceWithRecovery: async ({ proof }: Parameters<AppwriteSyncServices['directory']['activateDeviceWithRecovery']>[0]) => {
        if (!activationChallenge || !recoveryPublic.current) throw new Error('missing recovery fixture');
        await verifyRecoveryDeviceActivationProof({ challenge: activationChallenge, proof, recovery: recoveryPublic.current });
        return { device: registered(replacement), duplicate: false };
      },
    };
    const transport = {
      putKeyEnvelope: async (envelope: NotebookKeyEnvelope) => {
        stored.push({ envelopeId: `envelope-${stored.length}`, envelope, senderSigningPublicKey: owner.publicIdentity.signingPublicKey });
        return { envelopeId: `envelope-${stored.length - 1}`, duplicate: false };
      },
    };
    const services = { directory, transport } as unknown as AppwriteSyncServices;
    const initialized = await initializeOwnerNotebookKeys({ notebookId: 'notebook', identity: owner, services, store: ownerStore });
    const recoverySecret = await parseRecoveryCode(initialized.recoveryCode);
    recoveryPublic.current = recoverySecret.toJSON();
    await destroyRecoverySecret(recoverySecret);
    expect(stored.filter(({ envelope }) => envelope.keyEpoch === 1)).toHaveLength(3);

    await rotateAndRedistributeNotebookKey({ notebookId: 'notebook', identity: owner, services, store: ownerStore, keyring: initialized.keyring });
    expect(initialized.keyring.currentEpoch).toBe(2);
    const security = new AppwriteNotebookSecurityUi({ notebookId: 'notebook', identity: owner, services, store: ownerStore });
    security.setKeyring(initialized.keyring);
    await security.markDeviceLost('notebook', 'lost-device');
    expect(initialized.keyring.currentEpoch).toBe(3);
    const epochThreeDeviceRecipients = stored
      .filter(({ envelope }) => envelope.keyEpoch === 3 && envelope.recipient.kind === 'device')
      .map(({ envelope }) => envelope.recipient.kind === 'device' ? envelope.recipient.deviceId : '');
    expect(epochThreeDeviceRecipients).toEqual(['owner-device']);

    const recovered = await recoverAndActivateDevice({
      notebookId: 'notebook', identity: replacement, services, store: replacementStore,
      recoveryCode: initialized.recoveryCode,
    });
    expect(recovered.currentEpoch).toBe(3);
    expect(recovered.toJSON().availableEpochs).toEqual([1, 2, 3]);
  });
});

function memorySecretStore(): DeviceSeedSecretStore {
  const values = new Map<string, Uint8Array>();
  return {
    load: async (id) => values.get(id)?.slice(),
    save: async (id, value) => { values.set(id, value.slice()); value.fill(0); },
    clear: (id) => { values.delete(id); },
  };
}

function registered(identity: Awaited<ReturnType<typeof createDeviceIdentity>>): SyncRegisteredDevice {
  return {
    protocolVersion: 1, deviceId: identity.publicIdentity.deviceId,
    encryptionPublicKey: identity.publicIdentity.encryptionPublicKey,
    signingPublicKey: identity.publicIdentity.signingPublicKey,
    status: 'active', createdAt: '2026-08-03T12:00:00.000Z', updatedAt: '2026-08-03T12:00:00.000Z',
  };
}

function recipientMatches(envelope: NotebookKeyEnvelope, recipient: { kind: string; id: string }): boolean {
  if (envelope.recipient.kind !== recipient.kind) return false;
  const id = envelope.recipient.kind === 'device' ? envelope.recipient.deviceId
    : envelope.recipient.kind === 'account' ? envelope.recipient.accountId : envelope.recipient.recoveryKeyId;
  return id === recipient.id;
}
