import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type {
  AuthenticatedUser,
  ActivateDeviceRequest,
  ActivateDeviceWithRecoveryRequest,
  BeginAssetUpload,
  CompleteAssetUpload,
  CreateDeviceApprovalChallengeRequest,
  HeadsAcknowledgement,
  ListKeyEnvelopesRequest,
  ListMyDevicesRequest,
  ListNotebookDevicesRequest,
  MembershipRepository,
  NotebookKeyEnvelope,
  NotebookRole,
  PendingChangeEnvelope,
  RegisterDeviceRequest,
  RevokeDeviceRequest,
  SyncRepository,
  UploadAssetChunk,
} from "./contracts.js";
import {
  verifyAssetUploadAuthorization,
  verifyChangeSignature,
  verifyKeyEnvelopeSignature,
} from "./cryptoVerification.js";
import { ApiError } from "./errors.js";

const CAPABILITIES = Object.freeze({
  list: new Set<NotebookRole>(["owner", "editor", "viewer"]),
  acknowledge: new Set<NotebookRole>(["owner", "editor", "viewer"]),
  write: new Set<NotebookRole>(["owner", "editor"]),
  manageKeys: new Set<NotebookRole>(["owner"]),
});

export class SyncService {
  constructor(
    private readonly memberships: MembershipRepository,
    private readonly repository: SyncRepository,
  ) {}

  private async requireRole(
    user: AuthenticatedUser,
    notebookId: string,
    allowed: ReadonlySet<NotebookRole>,
  ): Promise<NotebookRole> {
    const role = await this.memberships.roleFor(notebookId, user.userId);
    if (role === null || !allowed.has(role)) {
      throw new ApiError(
        403,
        "forbidden",
        "The current account is not allowed to perform this operation.",
      );
    }
    return role;
  }

  private async requireOwnedActiveDevice(
    user: AuthenticatedUser,
    deviceId: string,
  ) {
    const device = await this.repository.getDevice(deviceId);
    if (
      device === null ||
      device.accountId !== user.userId ||
      device.status !== "active"
    ) {
      throw new ApiError(
        403,
        "forbidden",
        "The device is not active for the current account.",
      );
    }
    return device;
  }

  private async requireCurrentMember(
    notebookId: string,
    accountId: string,
  ): Promise<NotebookRole> {
    const role = await this.memberships.roleFor(notebookId, accountId);
    if (role === null || !CAPABILITIES.list.has(role)) {
      throw new ApiError(
        403,
        "forbidden",
        "The account is not a current notebook member.",
      );
    }
    return role;
  }

  registerDevice(user: AuthenticatedUser, request: RegisterDeviceRequest) {
    return this.repository.registerDevice(user.userId, request);
  }

  listMyDevices(user: AuthenticatedUser, request: ListMyDevicesRequest) {
    return this.repository.listMyDevices(user.userId, request);
  }

  async listNotebookDevices(
    user: AuthenticatedUser,
    request: ListNotebookDevicesRequest,
  ) {
    await this.requireRole(user, request.notebookId, CAPABILITIES.list);
    const accountIds = await this.memberships.memberAccountIds(
      request.notebookId,
    );
    return this.repository.listNotebookDevices(accountIds, request);
  }

  async revokeDevice(user: AuthenticatedUser, request: RevokeDeviceRequest) {
    const device = await this.repository.getDevice(request.deviceId);
    if (device === null)
      throw new ApiError(404, "not_found", "Device was not found.");
    if (device.accountId !== user.userId) {
      if (request.notebookId === undefined) {
        throw new ApiError(
          403,
          "forbidden",
          "Only the device account or a notebook owner may revoke it.",
        );
      }
      await this.requireRole(user, request.notebookId, CAPABILITIES.manageKeys);
      await this.requireCurrentMember(request.notebookId, device.accountId);
    }
    return this.repository.revokeDevice(request.deviceId);
  }

  async createDeviceApprovalChallenge(
    user: AuthenticatedUser,
    request: CreateDeviceApprovalChallengeRequest,
  ) {
    await this.requireRole(user, request.notebookId, CAPABILITIES.list);
    const device = await this.repository.getDevice(request.requestingDeviceId);
    if (
      device === null ||
      device.accountId !== user.userId ||
      device.status !== "pending"
    ) {
      throw new ApiError(
        403,
        "forbidden",
        "Only the account pending device may request approval.",
      );
    }
    return this.repository.createDeviceApprovalChallenge(user.userId, request);
  }

  async activateDevice(
    user: AuthenticatedUser,
    request: ActivateDeviceRequest,
  ) {
    const challenge = await this.repository.getDeviceApprovalChallenge(
      request.challengeId,
    );
    if (challenge === null)
      throw new ApiError(404, "not_found", "Approval challenge was not found.");
    if (challenge.accountId !== user.userId) {
      throw new ApiError(
        403,
        "forbidden",
        "Approval challenge belongs to another account.",
      );
    }
    await this.requireRole(user, challenge.notebookId, CAPABILITIES.list);
    return this.repository.activateDevice(user.userId, request);
  }

  async activateDeviceWithRecovery(
    user: AuthenticatedUser,
    request: ActivateDeviceWithRecoveryRequest,
  ) {
    const challenge = await this.repository.getDeviceApprovalChallenge(
      request.challengeId,
    );
    if (challenge === null)
      throw new ApiError(404, "not_found", "Approval challenge was not found.");
    if (challenge.accountId !== user.userId) {
      throw new ApiError(
        403,
        "forbidden",
        "Approval challenge belongs to another account.",
      );
    }
    await this.requireRole(user, challenge.notebookId, CAPABILITIES.list);
    return this.repository.activateDeviceWithRecovery(user.userId, request);
  }

  async listKeyEnvelopes(
    user: AuthenticatedUser,
    request: ListKeyEnvelopesRequest,
  ) {
    await this.requireRole(user, request.notebookId, CAPABILITIES.list);
    if (request.recipient.kind === "account") {
      if (request.recipient.id !== user.userId) {
        throw new ApiError(
          403,
          "forbidden",
          "Account key envelopes are visible only to their recipient.",
        );
      }
    } else if (request.recipient.kind === "device") {
      await this.requireOwnedActiveDevice(user, request.recipient.id);
    }
    return this.repository.listKeyEnvelopes(request);
  }

  async appendChange(user: AuthenticatedUser, envelope: PendingChangeEnvelope) {
    await this.requireRole(user, envelope.notebookId, CAPABILITIES.write);
    const sender = await this.requireOwnedActiveDevice(user, envelope.deviceId);
    verifyChangeSignature(envelope, sender.signingPublicKey);
    return this.repository.appendChange(envelope, user.userId);
  }

  async listChangesAfter(
    user: AuthenticatedUser,
    notebookId: string,
    afterSequence: number,
    limit: number,
  ) {
    await this.requireRole(user, notebookId, CAPABILITIES.list);
    return this.repository.listChangesAfter(notebookId, afterSequence, limit);
  }

  async acknowledgeHeads(
    user: AuthenticatedUser,
    acknowledgement: HeadsAcknowledgement,
  ) {
    await this.requireRole(
      user,
      acknowledgement.notebookId,
      CAPABILITIES.acknowledge,
    );
    await this.requireOwnedActiveDevice(user, acknowledgement.deviceId);
    return this.repository.acknowledgeHeads(acknowledgement);
  }

  async putKeyEnvelope(user: AuthenticatedUser, envelope: NotebookKeyEnvelope) {
    await this.requireRole(user, envelope.notebookId, CAPABILITIES.manageKeys);
    const sender = await this.requireOwnedActiveDevice(
      user,
      envelope.senderDeviceId,
    );
    if (sender.encryptionPublicKey !== envelope.senderEncryptionPublicKey) {
      throw new ApiError(
        409,
        "conflict",
        "The sender public key does not match its registered device.",
      );
    }
    verifyKeyEnvelopeSignature(envelope, sender.signingPublicKey);
    if (
      (envelope.recipient.kind === "recovery") !==
      (envelope.recoverySigningPublicKey !== undefined)
    ) {
      throw new ApiError(
        400,
        "bad_request",
        "Recovery signing keys are required only for recovery envelopes.",
      );
    }
    if (envelope.recipient.kind === "account") {
      await this.requireCurrentMember(
        envelope.notebookId,
        envelope.recipient.id,
      );
    } else if (envelope.recipient.kind === "device") {
      const recipient = await this.repository.getDevice(envelope.recipient.id);
      if (
        recipient === null ||
        recipient.status !== "active" ||
        recipient.encryptionPublicKey !== envelope.recipientEncryptionPublicKey
      ) {
        throw new ApiError(
          409,
          "conflict",
          "The recipient device or public key is not active and registered.",
        );
      }
      await this.requireCurrentMember(envelope.notebookId, recipient.accountId);
    }
    return this.repository.putKeyEnvelope(envelope);
  }

  async beginAssetUpload(user: AuthenticatedUser, request: BeginAssetUpload) {
    await this.requireRole(user, request.notebookId, CAPABILITIES.write);
    const device = await this.requireOwnedActiveDevice(user, request.deviceId);
    verifyAssetUploadAuthorization(request, device.signingPublicKey);
    return this.repository.beginAssetUpload(request);
  }

  async uploadAssetChunk(user: AuthenticatedUser, request: UploadAssetChunk) {
    await this.requireRole(user, request.notebookId, CAPABILITIES.write);
    const device = await this.requireOwnedActiveDevice(user, request.deviceId);
    verifyAssetUploadAuthorization(request, device.signingPublicKey);
    const bytes = Buffer.from(request.chunkBytes, "base64url");
    const chunkHash = createHash("sha256").update(bytes).digest("base64url");
    if (chunkHash !== request.chunkHash) {
      throw new ApiError(
        409,
        "conflict",
        "Encrypted asset chunk does not match its SHA-256 hash.",
      );
    }
    return this.repository.uploadAssetChunk(request);
  }

  async completeAssetUpload(
    user: AuthenticatedUser,
    request: CompleteAssetUpload,
  ) {
    await this.requireRole(user, request.notebookId, CAPABILITIES.write);
    const device = await this.requireOwnedActiveDevice(user, request.deviceId);
    verifyAssetUploadAuthorization(request, device.signingPublicKey);
    return this.repository.completeAssetUpload(request);
  }
}
