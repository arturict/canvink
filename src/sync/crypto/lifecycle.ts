import { SYNC_PROTOCOL_VERSION, type DevicePublicIdentity } from '../types';
import { canonicalEncode } from './encoding';
import {
  CryptoProtocolError,
  NOTEBOOK_KEY_BYTES,
  type DeviceSecretIdentity,
  type NotebookEpochKey,
  type RecoveryKit,
  type RecoveryPublicIdentity,
  type RecoverySecretIdentity,
} from './types';
import {
  assertEpoch,
  assertExactBytes,
  assertId,
  constantTimeEqual,
  randomBytes,
  readySodium,
  sha256,
  sodiumWipe,
  wipeBytes,
} from './sodium';

function clonePublicIdentity(identity: DevicePublicIdentity): DevicePublicIdentity {
  return {
    ...identity,
    encryptionPublicKey: Uint8Array.from(identity.encryptionPublicKey),
    signingPublicKey: Uint8Array.from(identity.signingPublicKey),
  };
}

export async function createDeviceIdentity(input: {
  accountId: string;
  deviceId: string;
  /** Exact 32-byte seeds support restoring persisted identities and deterministic tests. */
  encryptionSeed?: Uint8Array;
  signingSeed?: Uint8Array;
}): Promise<DeviceSecretIdentity> {
  const crypto = await readySodium();
  const encryptionSeed = input.encryptionSeed
    ? assertExactBytes(input.encryptionSeed, crypto.crypto_box_SEEDBYTES, 'Encryption seed')
    : await randomBytes(crypto.crypto_box_SEEDBYTES);
  const signingSeed = input.signingSeed
    ? assertExactBytes(input.signingSeed, crypto.crypto_sign_SEEDBYTES, 'Signing seed')
    : await randomBytes(crypto.crypto_sign_SEEDBYTES);
  let encryptionPrivateKey: Uint8Array | undefined;
  let signingPrivateKey: Uint8Array | undefined;
  try {
    const encryption = crypto.crypto_box_seed_keypair(encryptionSeed);
    const signing = crypto.crypto_sign_seed_keypair(signingSeed);
    encryptionPrivateKey = encryption.privateKey;
    signingPrivateKey = signing.privateKey;
    const publicIdentity: DevicePublicIdentity = {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      accountId: assertId(input.accountId, 'Account ID'),
      deviceId: assertId(input.deviceId, 'Device ID'),
      encryptionPublicKey: Uint8Array.from(encryption.publicKey),
      signingPublicKey: Uint8Array.from(signing.publicKey),
    };
    return {
      publicIdentity,
      encryptionPrivateKey: Uint8Array.from(encryption.privateKey),
      signingPrivateKey: Uint8Array.from(signing.privateKey),
      destroyed: false,
      toJSON: () => clonePublicIdentity(publicIdentity),
    };
  } finally {
    await sodiumWipe(
      encryptionSeed,
      signingSeed,
      encryptionPrivateKey,
      signingPrivateKey,
    );
  }
}

export async function destroyDeviceIdentity(identity: DeviceSecretIdentity): Promise<void> {
  await sodiumWipe(identity.encryptionPrivateKey, identity.signingPrivateKey);
  identity.destroyed = true;
}

export async function generateNotebookKey(notebookId: string, epoch = 1): Promise<NotebookEpochKey> {
  return {
    notebookId: assertId(notebookId, 'Notebook ID'),
    epoch: assertEpoch(epoch),
    key: await randomBytes(NOTEBOOK_KEY_BYTES),
  };
}

export class NotebookKeyring {
  readonly notebookId: string;
  private readonly keys = new Map<number, Uint8Array>();
  private current: number;
  private destroyed = false;

  constructor(initial: NotebookEpochKey) {
    this.notebookId = assertId(initial.notebookId, 'Notebook ID');
    this.current = assertEpoch(initial.epoch);
    this.keys.set(
      this.current,
      assertExactBytes(initial.key, NOTEBOOK_KEY_BYTES, 'Notebook key'),
    );
  }

  get currentEpoch(): number {
    return this.current;
  }

  currentKey(): NotebookEpochKey {
    return this.keyForEpoch(this.current);
  }

  keyForEpoch(epoch: number): NotebookEpochKey {
    this.assertUsable();
    const key = this.keys.get(assertEpoch(epoch));
    if (!key) throw new CryptoProtocolError('key-unavailable', 'Notebook key epoch is unavailable.');
    return { notebookId: this.notebookId, epoch, key: Uint8Array.from(key) };
  }

  async install(value: NotebookEpochKey): Promise<void> {
    this.assertUsable();
    if (value.notebookId !== this.notebookId) {
      throw new CryptoProtocolError('invalid-input', 'Notebook key belongs to another notebook.');
    }
    const epoch = assertEpoch(value.epoch);
    const incoming = assertExactBytes(value.key, NOTEBOOK_KEY_BYTES, 'Notebook key');
    const existing = this.keys.get(epoch);
    if (existing) {
      const same = await constantTimeEqual(existing, incoming);
      if (!same) {
        wipeBytes(incoming);
        throw new CryptoProtocolError('wrong-epoch', 'A different key is already installed for this epoch.');
      }
      wipeBytes(incoming);
      return;
    }
    this.keys.set(epoch, incoming);
    if (epoch > this.current) this.current = epoch;
  }

  async rotate(): Promise<NotebookEpochKey> {
    this.assertUsable();
    const next = await generateNotebookKey(this.notebookId, this.current + 1);
    this.keys.set(next.epoch, Uint8Array.from(next.key));
    this.current = next.epoch;
    return next;
  }

  async forget(epoch: number): Promise<void> {
    this.assertUsable();
    const value = this.keys.get(assertEpoch(epoch));
    if (!value) return;
    await sodiumWipe(value);
    this.keys.delete(epoch);
  }

  async destroy(): Promise<void> {
    for (const key of this.keys.values()) await sodiumWipe(key);
    this.keys.clear();
    this.destroyed = true;
  }

  toJSON(): { notebookId: string; currentEpoch: number; availableEpochs: number[] } {
    return {
      notebookId: this.notebookId,
      currentEpoch: this.current,
      availableEpochs: [...this.keys.keys()].sort((left, right) => left - right),
    };
  }

  private assertUsable(): void {
    if (this.destroyed) throw new CryptoProtocolError('destroyed-secret', 'Notebook keyring was destroyed.');
  }
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fromHex(value: string, length: number): Uint8Array {
  if (!new RegExp(`^[0-9a-f]{${length * 2}}$`).test(value)) {
    throw new CryptoProtocolError('recovery-code-invalid', 'Recovery code has an invalid encoding.');
  }
  return Uint8Array.from({ length }, (_, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16));
}

async function recoveryChecksum(seed: Uint8Array): Promise<Uint8Array> {
  return (await sha256(canonicalEncode('canvink/recovery-code-checksum/v1', [
    ['seed', seed],
  ]))).slice(0, 8);
}

async function recoveryPublic(seed: Uint8Array): Promise<RecoveryPublicIdentity> {
  const crypto = await readySodium();
  const pair = crypto.crypto_box_seed_keypair(seed);
  const signingSeed = await sha256(canonicalEncode('canvink/recovery-signing-seed/v1', [
    ['recoverySeed', seed],
  ]));
  const signing = crypto.crypto_sign_seed_keypair(signingSeed);
  try {
    const digest = await sha256(canonicalEncode('canvink/recovery-key-id/v1', [
      ['publicKey', pair.publicKey],
    ]));
    return {
      kind: 'recovery',
      recoveryKeyId: `recovery:${toHex(digest)}`,
      encryptionPublicKey: Uint8Array.from(pair.publicKey),
      signingPublicKey: Uint8Array.from(signing.publicKey),
    };
  } finally {
    await sodiumWipe(signingSeed, pair.privateKey, signing.privateKey);
  }
}

export async function generateRecoveryKit(): Promise<RecoveryKit> {
  const crypto = await readySodium();
  const seed = await randomBytes(crypto.crypto_box_SEEDBYTES);
  const recipient = await recoveryPublic(seed);
  const checksum = await recoveryChecksum(seed);
  let consumed = false;
  return {
    recipient,
    reveal(): string {
      if (consumed) {
        throw new CryptoProtocolError('recovery-code-consumed', 'Recovery code was already revealed.');
      }
      consumed = true;
      const code = `CNVK-R1-${toHex(seed)}-${toHex(checksum)}`;
      wipeBytes(seed, checksum);
      return code;
    },
    destroy(): void {
      consumed = true;
      wipeBytes(seed, checksum);
    },
    toJSON: () => ({
      ...recipient,
      encryptionPublicKey: Uint8Array.from(recipient.encryptionPublicKey),
      signingPublicKey: Uint8Array.from(recipient.signingPublicKey),
    }),
  };
}

export async function parseRecoveryCode(code: string): Promise<RecoverySecretIdentity> {
  const match = /^CNVK-R1-([0-9a-f]{64})-([0-9a-f]{16})$/.exec(code);
  if (!match) throw new CryptoProtocolError('recovery-code-invalid', 'Recovery code is malformed.');
  const seed = fromHex(match[1], 32);
  const suppliedChecksum = fromHex(match[2], 8);
  const expectedChecksum = await recoveryChecksum(seed);
  if (!(await constantTimeEqual(suppliedChecksum, expectedChecksum))) {
    await sodiumWipe(seed, suppliedChecksum, expectedChecksum);
    throw new CryptoProtocolError('recovery-code-invalid', 'Recovery code checksum is invalid.');
  }
  const crypto = await readySodium();
  const pair = crypto.crypto_box_seed_keypair(seed);
  const signingSeed = await sha256(canonicalEncode('canvink/recovery-signing-seed/v1', [
    ['recoverySeed', seed],
  ]));
  const signing = crypto.crypto_sign_seed_keypair(signingSeed);
  const publicIdentity = await recoveryPublic(seed);
  await sodiumWipe(seed, suppliedChecksum, expectedChecksum, signingSeed);
  const encryptionPrivateKey = Uint8Array.from(pair.privateKey);
  const signingPrivateKey = Uint8Array.from(signing.privateKey);
  await sodiumWipe(pair.privateKey, signing.privateKey);
  return {
    ...publicIdentity,
    encryptionPrivateKey,
    signingPrivateKey,
    destroyed: false,
    toJSON: () => ({
      ...publicIdentity,
      encryptionPublicKey: Uint8Array.from(publicIdentity.encryptionPublicKey),
      signingPublicKey: Uint8Array.from(publicIdentity.signingPublicKey),
    }),
  };
}

export async function destroyRecoverySecret(secret: RecoverySecretIdentity): Promise<void> {
  await sodiumWipe(secret.encryptionPrivateKey, secret.signingPrivateKey);
  secret.destroyed = true;
}

export async function recoveryIdentitiesEqual(
  left: RecoveryPublicIdentity,
  right: RecoveryPublicIdentity,
): Promise<boolean> {
  return (
    left.recoveryKeyId === right.recoveryKeyId &&
    (await constantTimeEqual(left.encryptionPublicKey, right.encryptionPublicKey)) &&
    (await constantTimeEqual(left.signingPublicKey, right.signingPublicKey))
  );
}
