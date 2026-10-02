import { describe, expect, it } from 'vitest';
import { bytes, syncEnvelope } from './testFixtures';
import {
  parseCatchUpPage,
  parseDevicePublicIdentity,
  parseHeadsAcknowledgement,
  parseNotebookKeyEnvelope,
  parseSequenceCursor,
  parseSyncEnvelope,
  SyncProtocolValidationError,
} from './validation';

describe('sync protocol validation', () => {
  it('accepts a strict envelope and defensively copies opaque byte payloads', () => {
    const source = syncEnvelope(1);
    const parsed = parseSyncEnvelope(source);

    source.ciphertext[0] = 99;

    expect(parsed.ciphertext).toEqual(bytes(1, 2));
    expect(parsed.sequence).toBe(1);
  });

  it('rejects extra metadata, invalid sequences, and non-byte ciphertext', () => {
    expect(() =>
      parseSyncEnvelope({ ...syncEnvelope(1), pageTitle: 'private' }),
    ).toThrow(SyncProtocolValidationError);
    expect(() => parseSyncEnvelope({ ...syncEnvelope(1), sequence: 0 })).toThrow(
      /sequence/,
    );
    expect(() =>
      parseSyncEnvelope({ ...syncEnvelope(1), ciphertext: 'not-bytes' }),
    ).toThrow(/Uint8Array/);
    const withoutEpoch: Record<string, unknown> = { ...syncEnvelope(1) };
    delete withoutEpoch.keyEpoch;
    expect(() => parseSyncEnvelope(withoutEpoch)).toThrow(/keyEpoch/);
  });

  it('validates device public identities without interpreting key bytes', () => {
    const identity = parseDevicePublicIdentity({
      protocolVersion: 1,
      accountId: 'account-1',
      deviceId: 'device-1',
      encryptionPublicKey: new Uint8Array(32).fill(1),
      signingPublicKey: new Uint8Array(32).fill(2),
    });

    expect(identity.deviceId).toBe('device-1');
    expect(identity.encryptionPublicKey).toEqual(new Uint8Array(32).fill(1));
  });

  it('supports strict device, account, and recovery key-envelope recipients', () => {
    const base = {
      protocolVersion: 1,
      notebookId: 'notebook-1',
      keyEpoch: 2,
      senderDeviceId: 'device-1',
      senderEncryptionPublicKey: new Uint8Array(32).fill(1),
      recipientEncryptionPublicKey: new Uint8Array(32).fill(2),
      nonce: new Uint8Array(24).fill(2),
      ciphertext: bytes(3),
      signature: new Uint8Array(64).fill(4),
    };

    expect(
      parseNotebookKeyEnvelope({
        ...base,
        recipient: { kind: 'device', deviceId: 'device-2' },
      }).recipient,
    ).toEqual({ kind: 'device', deviceId: 'device-2' });
    expect(
      parseNotebookKeyEnvelope({
        ...base,
        recipient: { kind: 'account', accountId: 'account-2' },
      }).recipient,
    ).toEqual({ kind: 'account', accountId: 'account-2' });
    expect(
      parseNotebookKeyEnvelope({
        ...base,
        recipient: { kind: 'recovery', recoveryKeyId: 'recovery-1' },
        recoverySigningPublicKey: new Uint8Array(32).fill(3),
      }).recipient,
    ).toEqual({ kind: 'recovery', recoveryKeyId: 'recovery-1' });
    const withoutRecipientKey: Record<string, unknown> = { ...base };
    delete withoutRecipientKey.recipientEncryptionPublicKey;
    expect(() =>
      parseNotebookKeyEnvelope({
        ...withoutRecipientKey,
        recipient: { kind: 'device', deviceId: 'device-2' },
      }),
    ).toThrow(/recipientEncryptionPublicKey/);
  });

  it('rejects duplicate document heads and non-contiguous catch-up pages', () => {
    expect(() =>
      parseHeadsAcknowledgement({
        protocolVersion: 1,
        notebookId: 'notebook-1',
        deviceId: 'device-1',
        sequence: 2,
        documents: [{ documentId: 'document-1', heads: [bytes(1), bytes(1)] }],
      }),
    ).toThrow(/duplicates/);

    expect(() =>
      parseCatchUpPage({
        notebookId: 'notebook-1',
        afterSequence: 0,
        snapshotSequence: 2,
        hasMore: false,
        envelopes: [syncEnvelope(2)],
      }),
    ).toThrow(/contiguous/);
  });

  it('validates a strict non-negative sequence cursor', () => {
    expect(
      parseSequenceCursor({ notebookId: 'notebook-1', contiguousSequence: 0 }),
    ).toEqual({ notebookId: 'notebook-1', contiguousSequence: 0 });
    expect(() =>
      parseSequenceCursor({
        notebookId: 'notebook-1',
        contiguousSequence: -1,
      }),
    ).toThrow(/contiguousSequence/);
  });
});
