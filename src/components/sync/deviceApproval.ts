import { approveDeviceChallenge, type DeviceSecretIdentity } from '../../sync/crypto';
import type { SyncDeviceDirectoryPort } from '../../sync/client';
import { SyncClientError, deviceApprovalChallengeFromJson, encodeBase64Url, decodeBase64Url } from '../../sync/client';
import type { SyncDeviceApprovalUiPort } from './controller';

const PREFIX = 'CNVK-A1-';

export class AppwriteDeviceApprovalUi implements SyncDeviceApprovalUiPort {
  constructor(
    private readonly directory: SyncDeviceDirectoryPort,
    private readonly identity: DeviceSecretIdentity,
  ) {}

  async createRequest(notebookId: string): Promise<{ requestCode: string }> {
    const request = await this.directory.createDeviceApprovalChallenge({
      notebookId,
      requestingDeviceId: this.identity.publicIdentity.deviceId,
    });
    return { requestCode: encodeApprovalRequest(request) };
  }

  async approveRequest(notebookId: string, requestCode: string): Promise<void> {
    const request = decodeApprovalRequest(requestCode);
    if (request.challenge.notebookId !== notebookId) throw new SyncClientError('protocol-error', 'Die Freigabeanfrage gehört zu einem anderen Notizbuch.');
    const proof = await approveDeviceChallenge(request.challenge, this.identity);
    const activated = await this.directory.activateDevice({ challengeId: request.challengeId, proof });
    if (activated.device.status !== 'active') throw new SyncClientError('key-epoch-unavailable', 'Der Dienst hat das neue Gerät nicht aktiviert.');
  }
}

export function encodeApprovalRequest(input: Awaited<ReturnType<SyncDeviceDirectoryPort['createDeviceApprovalChallenge']>>): string {
  const challenge = input.challenge;
  const json = JSON.stringify({
    challengeId: input.challengeId,
    challenge: {
      ...challenge,
      requestingEncryptionPublicKey: encodeBase64Url(challenge.requestingEncryptionPublicKey),
      requestingSigningPublicKey: encodeBase64Url(challenge.requestingSigningPublicKey),
      nonce: encodeBase64Url(challenge.nonce),
    },
  });
  return PREFIX + encodeBase64Url(new TextEncoder().encode(json));
}

export function decodeApprovalRequest(code: string): Awaited<ReturnType<SyncDeviceDirectoryPort['createDeviceApprovalChallenge']>> {
  if (!code.startsWith(PREFIX) || code.length > 8_192) throw new SyncClientError('protocol-error', 'Der Gerätefreigabecode ist ungültig.');
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64Url(code.slice(PREFIX.length), 'device approval code'))) as Record<string, unknown>;
    if (typeof value.challengeId !== 'string' || value.challengeId.length < 1 || value.challengeId.length > 256) throw new Error('challengeId');
    return { challengeId: value.challengeId, challenge: deviceApprovalChallengeFromJson(value.challenge) };
  } catch (error) {
    if (error instanceof SyncClientError) throw error;
    throw new SyncClientError('protocol-error', 'Der Gerätefreigabecode ist ungültig.', { cause: error });
  }
}
