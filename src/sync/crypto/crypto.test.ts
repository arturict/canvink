import { describe, expect, it } from 'vitest';
import { createInboundSyncState, ingestSyncEnvelope } from '../inbox';
import type { PendingSyncEnvelope } from '../types';
import {
  approveDeviceChallenge,
  assignServerSequence,
  createDeviceApprovalChallenge,
  createDeviceIdentity,
  createNotebookKeyEnvelope,
  createRecoveryDeviceActivationProof,
  CryptoProtocolError,
  destroyDeviceIdentity,
  destroyRecoverySecret,
  encryptAsset,
  encryptChange,
  generateRecoveryKit,
  MAX_ASSET_PLAINTEXT_BYTES,
  MAX_CHANGE_PLAINTEXT_BYTES,
  NotebookKeyring,
  openNotebookKeyEnvelope,
  parseRecoveryCode,
  sodiumWipe,
  verifyAndDecryptAsset,
  verifyAndDecryptChange,
  verifyDeviceApprovalProof,
  verifyRecoveryDeviceActivationProof,
  wipeBytes,
} from './index';

const encoder = new TextEncoder();
const seed = (marker: number) => new Uint8Array(32).fill(marker);
const nonce = (marker: number) => new Uint8Array(24).fill(marker);
const approvalNonce = (marker: number) => new Uint8Array(32).fill(marker);
const hex = (value: Uint8Array) =>
  Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');

async function identities() {
  const first = await createDeviceIdentity({
    accountId: 'account-1',
    deviceId: 'device-1',
    encryptionSeed: seed(1),
    signingSeed: seed(2),
  });
  const second = await createDeviceIdentity({
    accountId: 'account-1',
    deviceId: 'device-2',
    encryptionSeed: seed(3),
    signingSeed: seed(4),
  });
  const outsider = await createDeviceIdentity({
    accountId: 'account-2',
    deviceId: 'device-3',
    encryptionSeed: seed(5),
    signingSeed: seed(6),
  });
  return { first, second, outsider };
}

const notebookKey = {
  notebookId: 'notebook-1',
  epoch: 1,
  key: seed(9),
};

function mutate(envelope: PendingSyncEnvelope, field: 'ciphertext' | 'signature') {
  const copy = { ...envelope, [field]: Uint8Array.from(envelope[field]) };
  copy[field][0] ^= 1;
  return copy;
}

describe('sync cryptographic lifecycle', () => {
  it('derives deterministic device identities without serializing private keys', async () => {
    const { first } = await identities();
    const restored = await createDeviceIdentity({
      accountId: 'account-1',
      deviceId: 'device-1',
      encryptionSeed: seed(1),
      signingSeed: seed(2),
    });

    expect(restored.publicIdentity).toEqual(first.publicIdentity);
    expect(JSON.stringify(first)).not.toContain('PrivateKey');
    expect(JSON.parse(JSON.stringify(first))).toEqual({
      ...first.publicIdentity,
      encryptionPublicKey: expect.any(Object),
      signingPublicKey: expect.any(Object),
    });
  });

  it('encrypts and signs a deterministic change vector for two devices', async () => {
    const { first, second } = await identities();
    const plaintext = encoder.encode('automerge-change-vector');
    const encrypted = await encryptChange({
      notebookId: 'notebook-1',
      documentId: 'document-1',
      plaintext,
      notebookKey,
      sender: first,
      nonce: nonce(7),
    });
    const repeated = await encryptChange({
      notebookId: 'notebook-1',
      documentId: 'document-1',
      plaintext,
      notebookKey,
      sender: first,
      nonce: nonce(7),
    });

    expect(encrypted).toEqual(repeated);
    expect(hex(first.publicIdentity.encryptionPublicKey)).toBe(
      '1b1b58dd50ea14b60da17b790cd02754d970c9bab864ebb3c0f3016fe51d3f57',
    );
    expect(hex(first.publicIdentity.signingPublicKey)).toBe(
      '8139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b394',
    );
    expect(hex(encrypted.changeHash)).toBe(
      '35f5f0240c4c4480763604d87241cc645d4dbe37f2b0e7c5933786b8061f6189',
    );
    expect(hex(encrypted.ciphertext)).toBe(
      '692ce62be2b9db48790d43460bd5ae0fe44f08431788a49d9c1a42a940dc88fc23f00e365d43de',
    );
    expect(hex(encrypted.signature)).toBe(
      '406e42abdc2eec32b12a325e43b0b307c61f88d3f57e4466c5b5044e7d65cda048ab9990bda607174d3b2a750067b453f21de13b5c469a3638bc3a3c7a71f400',
    );
    expect(encrypted.changeHash).toHaveLength(32);
    expect(encrypted.nonce).toHaveLength(24);
    expect(encrypted.ciphertext).toHaveLength(plaintext.length + 16);
    expect(encrypted.signature).toHaveLength(64);
    await expect(
      verifyAndDecryptChange({
        envelope: encrypted,
        notebookKey,
        sender: first.publicIdentity,
      }),
    ).resolves.toEqual(plaintext);
    await expect(
      verifyAndDecryptChange({
        envelope: encrypted,
        notebookKey,
        sender: second.publicIdentity,
      }),
    ).rejects.toMatchObject({ code: 'wrong-device' });
  });

  it('binds change metadata, rejects tampering and wrong keys, and permits server sequence assignment', async () => {
    const { first } = await identities();
    const encrypted = await encryptChange({
      notebookId: 'notebook-1',
      documentId: 'document-1',
      plaintext: encoder.encode('change'),
      notebookKey,
      sender: first,
      nonce: nonce(8),
    });
    const committed = assignServerSequence(encrypted, 42);

    await expect(
      verifyAndDecryptChange({ envelope: committed, notebookKey, sender: first.publicIdentity }),
    ).resolves.toEqual(encoder.encode('change'));
    await expect(
      verifyAndDecryptChange({
        envelope: { ...committed, documentId: 'document-tampered' },
        notebookKey,
        sender: first.publicIdentity,
      }),
    ).rejects.toMatchObject({ code: 'signature-invalid' });
    await expect(
      verifyAndDecryptChange({
        envelope: mutate(encrypted, 'ciphertext'),
        notebookKey,
        sender: first.publicIdentity,
      }),
    ).rejects.toMatchObject({ code: 'signature-invalid' });
    await expect(
      verifyAndDecryptChange({
        envelope: mutate(encrypted, 'signature'),
        notebookKey,
        sender: first.publicIdentity,
      }),
    ).rejects.toMatchObject({ code: 'signature-invalid' });
    await expect(
      verifyAndDecryptChange({
        envelope: encrypted,
        notebookKey: { ...notebookKey, key: seed(10) },
        sender: first.publicIdentity,
      }),
    ).rejects.toMatchObject({ code: 'authentication-failed' });

    const state = createInboundSyncState('notebook-1');
    const firstIngest = ingestSyncEnvelope(state, committed);
    expect(firstIngest.accepted).toBe(true);
    if (!firstIngest.accepted) throw new Error('expected accepted envelope');
    expect(ingestSyncEnvelope(firstIngest.state, assignServerSequence(encrypted, 43))).toMatchObject({
      accepted: false,
      reason: 'replay',
    });
  });

  it('encrypts assets with content identity, metadata binding, and strict limits', async () => {
    const { first } = await identities();
    const plaintext = encoder.encode('asset bytes');
    const encrypted = await encryptAsset({
      notebookId: 'notebook-1',
      mimeType: 'Image/PNG',
      plaintext,
      notebookKey,
      sender: first,
      nonce: nonce(9),
    });

    expect(encrypted.assetId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(encrypted.mimeType).toBe('image/png');
    await expect(
      verifyAndDecryptAsset({ envelope: encrypted, notebookKey, sender: first.publicIdentity }),
    ).resolves.toEqual(plaintext);
    await expect(
      verifyAndDecryptAsset({
        envelope: { ...encrypted, mimeType: 'image/jpeg' },
        notebookKey,
        sender: first.publicIdentity,
      }),
    ).rejects.toMatchObject({ code: 'signature-invalid' });
    await expect(
      verifyAndDecryptAsset({
        envelope: { ...encrypted, plaintextSize: MAX_ASSET_PLAINTEXT_BYTES + 1 },
        notebookKey,
        sender: first.publicIdentity,
      }),
    ).rejects.toMatchObject({ code: 'limit-exceeded' });
    await expect(
      encryptChange({
        notebookId: 'notebook-1',
        documentId: 'document-1',
        plaintext: new Uint8Array(MAX_CHANGE_PLAINTEXT_BYTES + 1),
        notebookKey,
        sender: first,
      }),
    ).rejects.toMatchObject({ code: 'limit-exceeded' });
  });

  it('wraps notebook keys for devices, accounts, and one-time recovery codes', async () => {
    const { first, second, outsider } = await identities();
    for (const kind of ['device', 'account'] as const) {
      const envelope = await createNotebookKeyEnvelope({
        notebookKey,
        sender: first,
        recipient: { kind, identity: second.publicIdentity },
        nonce: nonce(kind === 'device' ? 10 : 11),
      });
      await expect(
        openNotebookKeyEnvelope({ envelope, sender: first.publicIdentity, recipient: second }),
      ).resolves.toEqual(notebookKey);
      await expect(
        openNotebookKeyEnvelope({ envelope, sender: first.publicIdentity, recipient: outsider }),
      ).rejects.toMatchObject({ code: 'wrong-recipient' });
      await expect(
        openNotebookKeyEnvelope({
          envelope: { ...envelope, keyEpoch: 2 },
          sender: first.publicIdentity,
          recipient: second,
        }),
      ).rejects.toMatchObject({ code: 'signature-invalid' });
    }

    const recovery = await generateRecoveryKit();
    const recoveryEnvelope = await createNotebookKeyEnvelope({
      notebookKey,
      sender: first,
      recipient: { kind: 'recovery', identity: recovery.recipient },
      nonce: nonce(12),
    });
    const code = recovery.reveal();
    expect(() => recovery.reveal()).toThrowError(CryptoProtocolError);
    const corruptCode = `${code.slice(0, -1)}${code.endsWith('0') ? '1' : '0'}`;
    await expect(parseRecoveryCode(corruptCode)).rejects.toMatchObject({
      code: 'recovery-code-invalid',
    });
    const recoverySecret = await parseRecoveryCode(code);
    await expect(
      openNotebookKeyEnvelope({
        envelope: recoveryEnvelope,
        sender: first.publicIdentity,
        recipient: recoverySecret,
      }),
    ).resolves.toEqual(notebookKey);
    await destroyRecoverySecret(recoverySecret);
    await expect(
      openNotebookKeyEnvelope({
        envelope: recoveryEnvelope,
        sender: first.publicIdentity,
        recipient: recoverySecret,
      }),
    ).rejects.toMatchObject({ code: 'destroyed-secret' });
  });

  it('rotates epochs without claiming old device revocation', async () => {
    const keyring = new NotebookKeyring(notebookKey);
    const epochTwo = await keyring.rotate();
    expect(epochTwo.epoch).toBe(2);
    expect(keyring.currentEpoch).toBe(2);
    expect(keyring.keyForEpoch(1)).toEqual(notebookKey);
    expect(JSON.stringify(keyring)).not.toContain(hex(notebookKey.key));
    await keyring.forget(1);
    expect(() => keyring.keyForEpoch(1)).toThrow(/unavailable/);
    await keyring.destroy();
    expect(() => keyring.currentKey()).toThrow(/destroyed/);
  });

  it('proves existing-device approval and rejects replay after expiry or metadata changes', async () => {
    const { first, second, outsider } = await identities();
    const challenge = await createDeviceApprovalChallenge({
      notebookId: 'notebook-1',
      requestingDevice: second.publicIdentity,
      now: 1_000,
      lifetimeMs: 5_000,
      nonce: approvalNonce(13),
    });
    const proof = await approveDeviceChallenge(challenge, first, 2_000);
    await expect(
      verifyDeviceApprovalProof({ challenge, proof, approver: first.publicIdentity, now: 3_000 }),
    ).resolves.toBeUndefined();
    await expect(
      verifyDeviceApprovalProof({ challenge, proof, approver: first.publicIdentity, now: 6_001 }),
    ).rejects.toMatchObject({ code: 'approval-invalid' });
    await expect(
      verifyDeviceApprovalProof({
        challenge: { ...challenge, notebookId: 'notebook-2' },
        proof,
        approver: first.publicIdentity,
        now: 3_000,
      }),
    ).rejects.toMatchObject({ code: 'approval-invalid' });
    await expect(approveDeviceChallenge(challenge, outsider, 2_000)).rejects.toMatchObject({
      code: 'approval-invalid',
    });
  });

  it('derives and verifies a recovery activation signature bound to the approval challenge', async () => {
    const { second } = await identities();
    const kit = await generateRecoveryKit();
    const recovery = await parseRecoveryCode(kit.reveal());
    const challenge = await createDeviceApprovalChallenge({
      notebookId: 'notebook-1', requestingDevice: second.publicIdentity,
      now: 1_000, lifetimeMs: 5_000, nonce: approvalNonce(17),
    });
    const proof = await createRecoveryDeviceActivationProof(challenge, recovery, 2_000);
    await expect(verifyRecoveryDeviceActivationProof({ challenge, proof, recovery, now: 3_000 })).resolves.toBeUndefined();
    await expect(verifyRecoveryDeviceActivationProof({ challenge: { ...challenge, requestingDeviceId: 'other' }, proof, recovery, now: 3_000 }))
      .rejects.toMatchObject({ code: 'approval-invalid' });
    await destroyRecoverySecret(recovery);
  });

  it('zeroizes explicit secret buffers and disables destroyed identities', async () => {
    const { first } = await identities();
    const encryptionPrivateKey = first.encryptionPrivateKey;
    const signingPrivateKey = first.signingPrivateKey;
    await destroyDeviceIdentity(first);
    expect([...encryptionPrivateKey]).toEqual(new Array(32).fill(0));
    expect([...signingPrivateKey]).toEqual(new Array(64).fill(0));
    await expect(
      encryptChange({
        notebookId: 'notebook-1',
        documentId: 'document-1',
        plaintext: encoder.encode('secret'),
        notebookKey,
        sender: first,
      }),
    ).rejects.toMatchObject({ code: 'destroyed-secret' });

    const syncWipe = seed(20);
    const asyncWipe = seed(21);
    wipeBytes(syncWipe);
    await sodiumWipe(asyncWipe);
    expect(syncWipe.every((byte) => byte === 0)).toBe(true);
    expect(asyncWipe.every((byte) => byte === 0)).toBe(true);
  });
});
