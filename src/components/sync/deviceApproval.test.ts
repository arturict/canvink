import { describe, expect, it, vi } from 'vitest';
import { createDeviceIdentity, createDeviceApprovalChallenge } from '../../sync/crypto';
import { AppwriteDeviceApprovalUi, decodeApprovalRequest, encodeApprovalRequest } from './deviceApproval';
import type { SyncDeviceDirectoryPort } from '../../sync/client';

const bytes = (length: number, fill: number) => new Uint8Array(length).fill(fill);

describe('manual existing-device approval bridge', () => {
  it('round-trips the bounded request code and submits a signed activation proof', async () => {
    const pending = await createDeviceIdentity({ accountId: 'account', deviceId: 'pending', encryptionSeed: bytes(32, 1), signingSeed: bytes(32, 2) });
    const active = await createDeviceIdentity({ accountId: 'account', deviceId: 'active', encryptionSeed: bytes(32, 3), signingSeed: bytes(32, 4) });
    const challenge = await createDeviceApprovalChallenge({ notebookId: 'notebook', requestingDevice: pending.publicIdentity, now: Date.now(), nonce: bytes(32, 5) });
    const activateDevice = vi.fn(async () => ({
      device: { protocolVersion: 1 as const, deviceId: 'pending', encryptionPublicKey: pending.publicIdentity.encryptionPublicKey, signingPublicKey: pending.publicIdentity.signingPublicKey, status: 'active' as const, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() },
      duplicate: false,
    }));
    const directory = {
      createDeviceApprovalChallenge: async () => ({ challengeId: 'challenge-1', challenge }),
      activateDevice,
    } as unknown as SyncDeviceDirectoryPort;
    const pendingUi = new AppwriteDeviceApprovalUi(directory, pending);
    const request = await pendingUi.createRequest('notebook');
    expect(decodeApprovalRequest(request.requestCode)).toMatchObject({ challengeId: 'challenge-1', challenge: { requestingDeviceId: 'pending' } });
    expect(encodeApprovalRequest({ challengeId: 'challenge-1', challenge })).toBe(request.requestCode);

    const activeUi = new AppwriteDeviceApprovalUi(directory, active);
    await activeUi.approveRequest('notebook', request.requestCode);
    expect(activateDevice).toHaveBeenCalledWith(expect.objectContaining({
      challengeId: 'challenge-1',
      proof: expect.objectContaining({ approverDeviceId: 'active' }),
    }));
  });
});
