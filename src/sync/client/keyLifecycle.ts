import {
  createNotebookKeyEnvelope,
  createRecoveryDeviceActivationProof,
  destroyRecoverySecret,
  generateRecoveryKit,
  openNotebookKeyEnvelope,
  parseRecoveryCode,
  type DeviceSecretIdentity,
  type NotebookEpochKey,
  type RecoveryPublicIdentity,
  type RecoverySecretIdentity,
} from '../crypto';
import type { DevicePublicIdentity } from '../types';
import { SyncClientError } from './errors';
import type { DeviceSeedSecretStore } from './cryptoAdapter';
import { ProtectedNotebookKeyring, type NotebookKeyringPort } from './keyringPersistence';
import type { AppwriteSyncServices } from './appwrite';
import type { SyncDeviceDirectoryPort, SyncStoredKeyEnvelope } from './types';
import type { SyncSecurityUiPort } from '../../components/sync/controller';
import { decodeBase64Url, encodeBase64Url } from './wire';

const RECOVERY_PUBLIC_PREFIX = 'recovery-public:';

export interface NotebookKeyLifecycleOptions {
  notebookId: string;
  identity: DeviceSecretIdentity;
  services: AppwriteSyncServices;
  store: DeviceSeedSecretStore;
}

export async function initializeOwnerNotebookKeys(options: NotebookKeyLifecycleOptions): Promise<{
  keyring: ProtectedNotebookKeyring;
  recoveryCode: string;
}> {
  const existing = await ProtectedNotebookKeyring.load(options.notebookId, options.store);
  if (existing) throw new SyncClientError('protocol-error', 'Notebook keys are already initialized.');
  const keyring = await ProtectedNotebookKeyring.create(options.notebookId, options.store);
  const recoveryKit = await generateRecoveryKit();
  const recovery = recoveryKit.toJSON();
  await saveRecoveryPublic(options.store, options.notebookId, recovery);
  await distributeEpoch({ ...options, keyring, recovery, epoch: keyring.currentKey() });
  return { keyring, recoveryCode: recoveryKit.reveal() };
}

export async function loadNotebookKeysFromEnvelopes(options: NotebookKeyLifecycleOptions & {
  recovery?: RecoverySecretIdentity;
}): Promise<ProtectedNotebookKeyring | undefined> {
  let keyring = await ProtectedNotebookKeyring.load(options.notebookId, options.store);
  const recipients: Array<{ kind: 'device' | 'account' | 'recovery'; id: string }> = [
    { kind: 'device', id: options.identity.publicIdentity.deviceId },
    { kind: 'account', id: options.identity.publicIdentity.accountId },
    ...(options.recovery ? [{ kind: 'recovery' as const, id: options.recovery.recoveryKeyId }] : []),
  ];
  const opened: NotebookEpochKey[] = [];
  for (const recipient of recipients) {
    for (const stored of await listAllKeyEnvelopes(options.services.directory, options.notebookId, recipient)) {
      const sender = senderIdentity(stored);
      const secret = recipient.kind === 'recovery' ? options.recovery : options.identity;
      if (!secret) continue;
      try {
        opened.push(await openNotebookKeyEnvelope({ envelope: stored.envelope, sender, recipient: secret }));
      } catch (error) {
        if (recipient.kind === 'account' && isWrongRecipient(error)) continue;
        throw error;
      }
    }
  }
  opened.sort((left, right) => left.epoch - right.epoch);
  for (const epoch of opened) {
    if (!keyring) keyring = await ProtectedNotebookKeyring.create(options.notebookId, options.store, epoch);
    else await keyring.install(epoch);
  }
  return keyring;
}

export async function rotateAndRedistributeNotebookKey(options: NotebookKeyLifecycleOptions & {
  keyring: NotebookKeyringPort;
}): Promise<{ recoveryCode?: string }> {
  const epoch = await options.keyring.rotate();
  let recovery = await loadRecoveryPublic(options.store, options.notebookId);
  let recoveryCode: string | undefined;
  if (!recovery) {
    const kit = await generateRecoveryKit();
    recovery = kit.toJSON();
    await saveRecoveryPublic(options.store, options.notebookId, recovery);
    recoveryCode = kit.reveal();
  }
  await distributeEpoch({ ...options, recovery, epoch });
  return recoveryCode ? { recoveryCode } : {};
}

export async function recoverAndActivateDevice(options: NotebookKeyLifecycleOptions & {
  recoveryCode: string;
}): Promise<ProtectedNotebookKeyring> {
  const recovery = await parseRecoveryCode(options.recoveryCode);
  try {
    const keyring = await loadNotebookKeysFromEnvelopes({ ...options, recovery });
    if (!keyring) throw new SyncClientError('key-epoch-unavailable', 'No recovery key envelopes are available for this notebook.');
    const request = await options.services.directory.createDeviceApprovalChallenge({
      notebookId: options.notebookId,
      requestingDeviceId: options.identity.publicIdentity.deviceId,
    });
    const proof = await createRecoveryDeviceActivationProof(request.challenge, recovery);
    const activated = await options.services.directory.activateDeviceWithRecovery({ challengeId: request.challengeId, proof });
    if (activated.device.status !== 'active') throw new SyncClientError('key-epoch-unavailable', 'Recovery did not activate this device.');
    await saveRecoveryPublic(options.store, options.notebookId, recovery.toJSON());
    return keyring;
  } finally {
    await destroyRecoverySecret(recovery);
  }
}

export class AppwriteNotebookSecurityUi implements SyncSecurityUiPort {
  private keyring?: ProtectedNotebookKeyring;
  constructor(private readonly options: NotebookKeyLifecycleOptions) {}

  setKeyring(keyring: ProtectedNotebookKeyring): void { this.keyring = keyring; }
  getKeyring(): ProtectedNotebookKeyring | undefined { return this.keyring; }
  async requestExistingDeviceApproval(): Promise<void> {
    throw new SyncClientError('key-epoch-unavailable', 'Use the signed device approval request flow.');
  }
  async recoverWithCode(notebookId: string, code: string): Promise<void> {
    this.assertNotebook(notebookId);
    this.keyring = await recoverAndActivateDevice({ ...this.options, recoveryCode: code });
  }
  async acknowledgeRecoveryCode(): Promise<void> { return undefined; }
  async rotateEpoch(notebookId: string): Promise<{ recoveryCode?: string }> {
    this.assertNotebook(notebookId);
    if (!this.keyring) throw new SyncClientError('key-epoch-unavailable', 'Notebook keyring is unavailable.');
    return rotateAndRedistributeNotebookKey({ ...this.options, keyring: this.keyring });
  }
  async markDeviceLost(notebookId: string, deviceId: string): Promise<void> {
    this.assertNotebook(notebookId);
    await this.options.services.directory.revokeDevice({ notebookId, deviceId });
    await this.rotateEpoch(notebookId);
  }
  private assertNotebook(notebookId: string): void {
    if (notebookId !== this.options.notebookId) throw new SyncClientError('protocol-error', 'Security action targets another notebook.');
  }
}

async function distributeEpoch(options: NotebookKeyLifecycleOptions & {
  keyring: NotebookKeyringPort;
  recovery: RecoveryPublicIdentity;
  epoch: NotebookEpochKey;
}): Promise<void> {
  const devices = await listAllNotebookDevices(options.services.directory, options.notebookId);
  if (!devices.some((device) => device.deviceId === options.identity.publicIdentity.deviceId)) {
    throw new SyncClientError('key-epoch-unavailable', 'The rotating device is not active in this notebook.');
  }
  for (const device of devices) {
    await options.services.transport.putKeyEnvelope(await createNotebookKeyEnvelope({
      notebookKey: options.epoch,
      sender: options.identity,
      recipient: { kind: 'device', identity: {
        protocolVersion: 1,
        accountId: 'notebook-member',
        deviceId: device.deviceId,
        encryptionPublicKey: device.encryptionPublicKey,
        signingPublicKey: device.signingPublicKey,
      } },
    }));
  }
  await options.services.transport.putKeyEnvelope(await createNotebookKeyEnvelope({
    notebookKey: options.epoch,
    sender: options.identity,
    recipient: { kind: 'recovery', identity: options.recovery },
  }));
}

async function listAllNotebookDevices(directory: SyncDeviceDirectoryPort, notebookId: string) {
  const devices = [];
  let cursor: string | undefined;
  do {
    const page = await directory.listNotebookDevices({ notebookId, ...(cursor ? { cursor } : {}), limit: 50 });
    devices.push(...page.devices);
    cursor = page.nextCursor;
  } while (cursor && devices.length < 5_000);
  if (cursor) throw new SyncClientError('protocol-error', 'Notebook device directory exceeds the supported bound.');
  return devices;
}

async function listAllKeyEnvelopes(
  directory: SyncDeviceDirectoryPort,
  notebookId: string,
  recipient: { kind: 'device' | 'account' | 'recovery'; id: string },
): Promise<SyncStoredKeyEnvelope[]> {
  const envelopes: SyncStoredKeyEnvelope[] = [];
  let cursor: string | undefined;
  do {
    const page = await directory.listKeyEnvelopes({ notebookId, recipient, ...(cursor ? { cursor } : {}), limit: 50 });
    envelopes.push(...page.envelopes);
    cursor = page.nextCursor;
  } while (cursor && envelopes.length < 10_000);
  if (cursor) throw new SyncClientError('protocol-error', 'Key envelope directory exceeds the supported bound.');
  return envelopes;
}

function senderIdentity(stored: SyncStoredKeyEnvelope): DevicePublicIdentity {
  return {
    protocolVersion: 1,
    accountId: 'notebook-member',
    deviceId: stored.envelope.senderDeviceId,
    encryptionPublicKey: stored.envelope.senderEncryptionPublicKey,
    signingPublicKey: stored.senderSigningPublicKey,
  };
}

function isWrongRecipient(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'wrong-recipient';
}

async function saveRecoveryPublic(store: DeviceSeedSecretStore, notebookId: string, identity: RecoveryPublicIdentity): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify({
    kind: 'recovery', recoveryKeyId: identity.recoveryKeyId,
    encryptionPublicKey: encodeBase64Url(identity.encryptionPublicKey),
    signingPublicKey: encodeBase64Url(identity.signingPublicKey),
  }));
  try { await store.save(RECOVERY_PUBLIC_PREFIX + notebookId, bytes); } finally { bytes.fill(0); }
}

async function loadRecoveryPublic(store: DeviceSeedSecretStore, notebookId: string): Promise<RecoveryPublicIdentity | undefined> {
  const bytes = await store.load(RECOVERY_PUBLIC_PREFIX + notebookId);
  if (!bytes) return undefined;
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Record<string, unknown>;
    if (value.kind !== 'recovery' || typeof value.recoveryKeyId !== 'string') throw new Error('metadata');
    const encryptionPublicKey = decodeBase64Url(value.encryptionPublicKey, 'recovery encryption public key');
    const signingPublicKey = decodeBase64Url(value.signingPublicKey, 'recovery signing public key');
    if (encryptionPublicKey.byteLength !== 32 || signingPublicKey.byteLength !== 32) throw new Error('keys');
    return { kind: 'recovery', recoveryKeyId: value.recoveryKeyId, encryptionPublicKey, signingPublicKey };
  } catch (error) {
    throw new SyncClientError('key-epoch-unavailable', 'Protected recovery metadata is invalid.', { cause: error });
  } finally { bytes.fill(0); }
}
