import type { Doc } from "@automerge/automerge";
import type {
  CatchUpPage,
  DevicePublicIdentity,
  DocumentHeads,
  HeadsAcknowledgement,
  InboundSyncState,
  NotebookKeyEnvelope,
  OutboxState,
  PendingSyncEnvelope,
  SyncEnvelope,
} from "../types";
import type {
  DeviceApprovalChallenge,
  DeviceApprovalProof,
  DeviceSecretIdentity,
  EncryptedAssetEnvelope,
  RecoveryDeviceActivationProof,
} from "../crypto";

export type NotebookRole = "owner" | "editor" | "viewer";

export type SyncConfiguration =
  | { enabled?: false }
  | {
      enabled: true;
      endpoint: string;
      projectId: string;
      functionId: string;
      databaseId: string;
      changesTableId: string;
      assetBucketId: string;
    };

export type EnabledSyncConfiguration = Extract<
  SyncConfiguration,
  { enabled: true }
>;

export interface SyncAccount {
  userId: string;
  name: string;
  email?: string;
}

export interface EmailOtpChallenge {
  userId: string;
  expire: string;
  phrase?: string;
}

export interface SyncAuthPort {
  startMicrosoftOAuth(input: {
    success: string;
    failure: string;
    open?: (url: string) => void;
  }): Promise<void>;
  startEmailOtp(email: string): Promise<EmailOtpChallenge>;
  completeEmailOtp(userId: string, secret: string): Promise<SyncAccount>;
  currentAccount(): Promise<SyncAccount | null>;
  logout(): Promise<void>;
  roleForNotebook(
    notebookId: string,
    userId: string,
  ): Promise<NotebookRole | null>;
}

export interface SyncTeamMember {
  membershipId: string;
  userId: string;
  name: string;
  email: string;
  role: NotebookRole;
  confirmed: boolean;
}

export interface SyncTeamAdminPort {
  enableNotebookTeam(notebookId: string, displayName: string): Promise<void>;
  listMembers(notebookId: string): Promise<readonly SyncTeamMember[]>;
  inviteMember(input: {
    notebookId: string;
    email: string;
    role: NotebookRole;
    redirectUrl: string;
  }): Promise<SyncTeamMember>;
  updateMemberRole(
    notebookId: string,
    membershipId: string,
    role: NotebookRole,
  ): Promise<SyncTeamMember>;
  removeMember(notebookId: string, membershipId: string): Promise<void>;
}

export interface SyncRegisteredDevice {
  protocolVersion: 1;
  deviceId: string;
  encryptionPublicKey: Uint8Array;
  signingPublicKey: Uint8Array;
  status: "pending" | "active" | "revoked";
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
}

export interface SyncDeviceDirectoryPort {
  registerDevice(
    identity: Pick<
      DevicePublicIdentity,
      | "protocolVersion"
      | "deviceId"
      | "encryptionPublicKey"
      | "signingPublicKey"
    >,
  ): Promise<{
    device: SyncRegisteredDevice;
    duplicate: boolean;
    bootstrap: boolean;
  }>;
  listMyDevices(input?: {
    cursor?: string;
    limit?: number;
  }): Promise<{
    devices: readonly SyncRegisteredDevice[];
    nextCursor?: string;
  }>;
  listNotebookDevices(input: {
    notebookId: string;
    cursor?: string;
    limit?: number;
  }): Promise<{
    devices: readonly SyncRegisteredDevice[];
    nextCursor?: string;
  }>;
  revokeDevice(input: {
    deviceId: string;
    notebookId?: string;
  }): Promise<{ device: SyncRegisteredDevice; duplicate: boolean }>;
  createDeviceApprovalChallenge(input: {
    notebookId: string;
    requestingDeviceId: string;
  }): Promise<{ challengeId: string; challenge: DeviceApprovalChallenge }>;
  activateDevice(input: {
    challengeId: string;
    proof: DeviceApprovalProof;
  }): Promise<{ device: SyncRegisteredDevice; duplicate: boolean }>;
  activateDeviceWithRecovery(input: {
    challengeId: string;
    proof: RecoveryDeviceActivationProof;
  }): Promise<{ device: SyncRegisteredDevice; duplicate: boolean }>;
  listKeyEnvelopes(input: {
    notebookId: string;
    recipient: { kind: "account" | "device" | "recovery"; id: string };
    cursor?: string;
    limit?: number;
  }): Promise<{
    envelopes: readonly SyncStoredKeyEnvelope[];
    nextCursor?: string;
  }>;
}

export interface SyncStoredKeyEnvelope {
  envelopeId: string;
  envelope: NotebookKeyEnvelope;
  senderSigningPublicKey: Uint8Array;
}

export interface AssetReservation {
  protocolVersion: 1;
  notebookId: string;
  deviceId: string;
  encryptedHash: string;
  encryptedSize: number;
  uploadSignature: string;
  assetId: string;
  fileId: string;
  bucketId: string;
  chunkCount: number;
  status: "pending" | "uploading" | "cleaning" | "complete";
  expiresAt: string;
  leaseExpiresAt?: string;
  completedAt?: string;
}

export interface SyncTransportPort {
  setAssetUploadIdentity?(identity: DeviceSecretIdentity): void;
  appendChange(
    envelope: PendingSyncEnvelope,
    signal?: AbortSignal,
  ): Promise<{ envelope: SyncEnvelope; duplicate: boolean }>;
  listChangesAfter(
    notebookId: string,
    afterSequence: number,
    limit: number,
    signal?: AbortSignal,
  ): Promise<CatchUpPage>;
  acknowledgeHeads(
    value: HeadsAcknowledgement,
    signal?: AbortSignal,
  ): Promise<{ accepted: number; sequence: number }>;
  putKeyEnvelope(
    value: NotebookKeyEnvelope,
    signal?: AbortSignal,
  ): Promise<{ envelopeId: string; duplicate: boolean }>;
  uploadEncryptedAsset(
    value: EncryptedAssetEnvelope,
    signal?: AbortSignal,
  ): Promise<AssetReservation>;
  downloadEncryptedAsset(input: {
    reservation: Pick<AssetReservation, "bucketId" | "fileId">;
    metadata: Omit<
      EncryptedAssetEnvelope,
      "nonce" | "ciphertext" | "signature"
    >;
    signal?: AbortSignal;
  }): Promise<EncryptedAssetEnvelope>;
}

export interface DurableSyncSnapshot {
  version: 1;
  notebookId: string;
  outbox: OutboxState;
  inbox: InboundSyncState;
}

export interface DurableSyncStatePort {
  load(notebookId: string): Promise<DurableSyncSnapshot | undefined>;
  save(snapshot: DurableSyncSnapshot): Promise<void>;
}

export interface SyncCryptoPort {
  encryptChange(
    documentId: string,
    plaintext: Uint8Array,
  ): Promise<PendingSyncEnvelope>;
  decryptChange(envelope: SyncEnvelope): Promise<Uint8Array>;
  currentKeyEpoch(): number;
  awaitKeyEpoch(epoch: number, signal: AbortSignal): Promise<void>;
}

export interface SyncDocumentPort {
  applyRemoteChange(documentId: string, change: Uint8Array): Promise<void>;
  heads(): Promise<readonly DocumentHeads[]>;
  /** Complete local authority used to repopulate a reset server. */
  allChanges(): Promise<
    ReadonlyArray<{ documentId: string; change: Uint8Array }>
  >;
}

export interface PresenceCursor {
  x: number;
  y: number;
}

export interface PresenceSelection {
  anchor: number;
  head: number;
}

export interface NotebookPresence {
  notebookId: string;
  deviceId: string;
  name: string;
  color: string;
  pageId: string;
  cursor?: PresenceCursor;
  selection?: PresenceSelection;
}

export interface SyncRealtimePort {
  subscribe(input: {
    notebookId: string;
    onWake: () => void;
    onPresence: (presence: NotebookPresence) => void;
  }): Promise<() => Promise<void>>;
  publishPresence(presence: NotebookPresence): Promise<void>;
  disconnect(): Promise<void>;
}

export interface NetworkStatePort {
  isOnline(): boolean;
  subscribe(listener: (online: boolean) => void): () => void;
}

export interface BackoffPort {
  wait(milliseconds: number, signal: AbortSignal): Promise<void>;
}

export interface AutomergeDocumentEntry<
  T extends object = Record<string, unknown>,
> {
  documentId: string;
  document: Doc<T>;
}
