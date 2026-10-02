export const SYNC_PROTOCOL_VERSION = 1 as const;

export const LIMITS = Object.freeze({
  requestBytes: 6 * 1024 * 1024,
  ciphertextBytes: 4 * 1024 * 1024,
  keyEnvelopeBytes: 64 * 1024,
  assetBytes: 64 * 1024 * 1024,
  catchUpPage: 100,
  acknowledgementDocuments: 64,
  headsPerDocument: 64,
  directoryPage: 50,
  notebookMembers: 100,
  transactionRetries: 5,
  pendingAssetsPerNotebook: 64,
  pendingAssetsPerDevice: 16,
  assetCleanupBatch: 25,
  assetChunkBytes: 3 * 1024 * 1024,
  assetLeaseSeconds: 10 * 60,
  assetTransactionRetries: 32,
});

export type NotebookRole = "owner" | "editor" | "viewer";
export type RecipientKind = "account" | "device" | "recovery";

export interface AuthenticatedUser {
  userId: string;
  jwt: string;
}

export interface PendingChangeEnvelope {
  protocolVersion: typeof SYNC_PROTOCOL_VERSION;
  notebookId: string;
  documentId: string;
  deviceId: string;
  keyEpoch: number;
  changeHash: string;
  nonce: string;
  ciphertext: string;
  signature: string;
}

export interface CommittedChangeEnvelope extends PendingChangeEnvelope {
  sequence: number;
}

export interface CatchUpPage {
  notebookId: string;
  afterSequence: number;
  snapshotSequence: number;
  hasMore: boolean;
  envelopes: CommittedChangeEnvelope[];
}

export interface HeadsAcknowledgement {
  protocolVersion: typeof SYNC_PROTOCOL_VERSION;
  notebookId: string;
  deviceId: string;
  sequence: number;
  documents: Array<{ documentId: string; heads: string[] }>;
}

export interface NotebookKeyEnvelope {
  protocolVersion: typeof SYNC_PROTOCOL_VERSION;
  notebookId: string;
  keyEpoch: number;
  senderDeviceId: string;
  recipient: { kind: RecipientKind; id: string };
  senderEncryptionPublicKey: string;
  recipientEncryptionPublicKey: string;
  recoverySigningPublicKey?: string;
  nonce: string;
  ciphertext: string;
  signature: string;
  envelopeHash: string;
}

export type DeviceStatus = "pending" | "active" | "revoked";

export interface RegisterDeviceRequest {
  protocolVersion: typeof SYNC_PROTOCOL_VERSION;
  deviceId: string;
  encryptionPublicKey: string;
  signingPublicKey: string;
}

export interface RegisteredDevice extends RegisterDeviceRequest {
  status: DeviceStatus;
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
}

export interface RegisteredDeviceRecord extends RegisteredDevice {
  accountId: string;
}

export interface DeviceDirectoryPage {
  devices: RegisteredDevice[];
  nextCursor?: string;
}

export interface KeyEnvelopeDirectoryPage {
  envelopes: StoredKeyEnvelope[];
  nextCursor?: string;
}

export interface ListMyDevicesRequest {
  cursor?: string;
  limit: number;
}

export interface ListNotebookDevicesRequest extends ListMyDevicesRequest {
  notebookId: string;
}

export interface RevokeDeviceRequest {
  deviceId: string;
  notebookId?: string;
}

export interface CreateDeviceApprovalChallengeRequest {
  protocolVersion: typeof SYNC_PROTOCOL_VERSION;
  notebookId: string;
  requestingDeviceId: string;
}

export interface DeviceApprovalChallenge {
  protocolVersion: typeof SYNC_PROTOCOL_VERSION;
  notebookId: string;
  accountId: string;
  requestingDeviceId: string;
  requestingEncryptionPublicKey: string;
  requestingSigningPublicKey: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
}

export interface DeviceApprovalProof {
  protocolVersion: typeof SYNC_PROTOCOL_VERSION;
  approverDeviceId: string;
  challengeHash: string;
  signature: string;
}

export interface ActivateDeviceRequest {
  challengeId: string;
  proof: DeviceApprovalProof;
}

export interface RecoveryDeviceApprovalProof {
  protocolVersion: typeof SYNC_PROTOCOL_VERSION;
  recoveryKeyId: string;
  challengeHash: string;
  signature: string;
}

export interface ActivateDeviceWithRecoveryRequest {
  challengeId: string;
  proof: RecoveryDeviceApprovalProof;
}

export interface StoredDeviceApprovalChallenge extends DeviceApprovalChallenge {
  challengeId: string;
  status: "pending" | "consumed";
  consumedAt?: string;
  approverDeviceId?: string;
}

export interface ListKeyEnvelopesRequest {
  notebookId: string;
  recipient: { kind: RecipientKind; id: string };
  cursor?: string;
  limit: number;
}

export interface StoredKeyEnvelope extends NotebookKeyEnvelope {
  envelopeId: string;
  senderSigningPublicKey: string;
}

export interface BeginAssetUpload {
  protocolVersion: typeof SYNC_PROTOCOL_VERSION;
  notebookId: string;
  deviceId: string;
  encryptedHash: string;
  encryptedSize: number;
  uploadSignature: string;
}

export interface AssetReservation extends BeginAssetUpload {
  assetId: string;
  fileId: string;
  bucketId: string;
  chunkCount: number;
  status: "pending" | "uploading" | "cleaning" | "complete";
  expiresAt: string;
  leaseExpiresAt?: string;
  completedAt?: string;
}

export interface UploadAssetChunk extends BeginAssetUpload {
  assetId: string;
  fileId: string;
  chunkIndex: number;
  chunkCount: number;
  chunkHash: string;
  chunkBytes: string;
}

export interface CompleteAssetUpload {
  protocolVersion: typeof SYNC_PROTOCOL_VERSION;
  notebookId: string;
  deviceId: string;
  assetId: string;
  fileId: string;
  encryptedHash: string;
  encryptedSize: number;
  uploadSignature: string;
}

export interface IdentityVerifier {
  verify(jwt: string): Promise<string>;
}

export interface MembershipRepository {
  roleFor(notebookId: string, userId: string): Promise<NotebookRole | null>;
  memberAccountIds(notebookId: string): Promise<string[]>;
}

export interface SyncRepository {
  registerDevice(
    accountId: string,
    request: RegisterDeviceRequest,
  ): Promise<{
    device: RegisteredDevice;
    duplicate: boolean;
    bootstrap: boolean;
  }>;
  getDevice(deviceId: string): Promise<RegisteredDeviceRecord | null>;
  listMyDevices(
    accountId: string,
    request: ListMyDevicesRequest,
  ): Promise<DeviceDirectoryPage>;
  listNotebookDevices(
    accountIds: readonly string[],
    request: ListNotebookDevicesRequest,
  ): Promise<DeviceDirectoryPage>;
  revokeDevice(
    deviceId: string,
  ): Promise<{ device: RegisteredDevice; duplicate: boolean }>;
  createDeviceApprovalChallenge(
    accountId: string,
    request: CreateDeviceApprovalChallengeRequest,
  ): Promise<{ challengeId: string; challenge: DeviceApprovalChallenge }>;
  getDeviceApprovalChallenge(
    challengeId: string,
  ): Promise<StoredDeviceApprovalChallenge | null>;
  activateDevice(
    accountId: string,
    request: ActivateDeviceRequest,
  ): Promise<{ device: RegisteredDevice; duplicate: boolean }>;
  activateDeviceWithRecovery(
    accountId: string,
    request: ActivateDeviceWithRecoveryRequest,
  ): Promise<{ device: RegisteredDevice; duplicate: boolean }>;
  listKeyEnvelopes(
    request: ListKeyEnvelopesRequest,
  ): Promise<KeyEnvelopeDirectoryPage>;
  appendChange(
    envelope: PendingChangeEnvelope,
    createdBy: string,
  ): Promise<{
    envelope: CommittedChangeEnvelope;
    duplicate: boolean;
  }>;
  listChangesAfter(
    notebookId: string,
    afterSequence: number,
    limit: number,
  ): Promise<CatchUpPage>;
  acknowledgeHeads(
    acknowledgement: HeadsAcknowledgement,
  ): Promise<{ accepted: number; sequence: number }>;
  putKeyEnvelope(
    envelope: NotebookKeyEnvelope,
  ): Promise<{ envelopeId: string; duplicate: boolean }>;
  beginAssetUpload(
    request: BeginAssetUpload,
  ): Promise<{ reservation: AssetReservation; duplicate: boolean }>;
  uploadAssetChunk(
    request: UploadAssetChunk,
  ): Promise<{ acceptedBytes: number; duplicate: boolean }>;
  completeAssetUpload(
    request: CompleteAssetUpload,
  ): Promise<{ reservation: AssetReservation; duplicate: boolean }>;
}

export interface Clock {
  now(): Date;
}
