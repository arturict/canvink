import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import {
  type ActivateDeviceRequest,
  type ActivateDeviceWithRecoveryRequest,
  LIMITS,
  type AssetReservation,
  type BeginAssetUpload,
  type CatchUpPage,
  type CommittedChangeEnvelope,
  type CompleteAssetUpload,
  type CreateDeviceApprovalChallengeRequest,
  type DeviceApprovalChallenge,
  type HeadsAcknowledgement,
  type ListKeyEnvelopesRequest,
  type ListMyDevicesRequest,
  type ListNotebookDevicesRequest,
  type NotebookKeyEnvelope,
  type PendingChangeEnvelope,
  type RegisteredDevice,
  type RegisteredDeviceRecord,
  type RegisterDeviceRequest,
  type StoredKeyEnvelope,
  type StoredDeviceApprovalChallenge,
  type SyncRepository,
  type UploadAssetChunk,
} from "./contracts.js";
import {
  verifyApprovalProof,
  verifyRecoveryApprovalProof,
} from "./cryptoVerification.js";
import { ApiError, conflict } from "./errors.js";

export const RESOURCE_IDS = Object.freeze({
  database: "canvink-sync",
  notebooks: "sync_notebooks",
  changes: "sync_changes",
  heads: "sync_heads",
  devices: "sync_devices",
  deviceAccounts: "sync_device_accounts",
  deviceChallenges: "sync_device_challenges",
  keyEnvelopes: "sync_key_envelopes",
  assets: "sync_assets",
  assetQuotas: "sync_asset_quotas",
  assetBucket: "canvink-encrypted-assets",
});

export interface RowRecord {
  $id: string;
  [key: string]: unknown;
}

export interface RowQuery {
  equal?: Record<string, string | number | (string | number)[]>;
  greaterThan?: Record<string, number>;
  lessThan?: Record<string, string | number>;
  orderAsc?: string;
  cursorAfter?: string;
  limit: number;
}

export interface AppwriteDataPort {
  createTransaction(ttlSeconds: number): Promise<string>;
  commitTransaction(transactionId: string): Promise<void>;
  rollbackTransaction(transactionId: string): Promise<void>;
  getRow(
    tableId: string,
    rowId: string,
    transactionId?: string,
  ): Promise<RowRecord | null>;
  listRows(
    tableId: string,
    query: RowQuery,
    transactionId?: string,
  ): Promise<RowRecord[]>;
  createRow(
    tableId: string,
    rowId: string,
    data: Record<string, unknown>,
    permissions: string[],
    transactionId: string,
  ): Promise<void>;
  updateRow(
    tableId: string,
    rowId: string,
    data: Record<string, unknown>,
    permissions: string[] | undefined,
    transactionId: string,
  ): Promise<void>;
  deleteRow(
    tableId: string,
    rowId: string,
    transactionId?: string,
  ): Promise<void>;
}

export interface EncryptedAssetPort {
  inspect(
    fileId: string,
  ): Promise<{ encryptedSize: number; encryptedHash: string }>;
  sealToNotebook(fileId: string, notebookId: string): Promise<void>;
  stageChunk(
    assetId: string,
    chunkIndex: number,
    chunkBytes: Uint8Array,
    chunkHash: string,
  ): Promise<{ duplicate: boolean }>;
  assembleStagedChunks(
    fileId: string,
    assetId: string,
    chunkCount: number,
  ): Promise<{ encryptedSize: number; encryptedHash: string }>;
  removeStagedChunks(assetId: string, chunkCount: number): Promise<void>;
  removeIfExists(fileId: string): Promise<void>;
}

export interface RepositoryOptions {
  now?: () => Date;
  retryDelay?: (attempt: number) => Promise<void>;
}

function deterministicId(prefix: string, ...parts: string[]): string {
  const digest = createHash("sha256")
    .update(parts.join("\0"), "utf8")
    .digest("hex");
  return `${prefix}_${digest.slice(0, 32)}`;
}

function isCode(error: unknown, code: number): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function value(row: RowRecord, key: string): unknown {
  return row[key];
}

function stringValue(row: RowRecord, key: string): string {
  const candidate = value(row, key);
  if (typeof candidate !== "string")
    throw new ApiError(
      503,
      "service_unavailable",
      "Stored sync data is malformed.",
    );
  return candidate;
}

function integerValue(row: RowRecord, key: string): number {
  const candidate = value(row, key);
  if (!Number.isSafeInteger(candidate))
    throw new ApiError(
      503,
      "service_unavailable",
      "Stored sync data is malformed.",
    );
  return candidate as number;
}

function booleanValue(row: RowRecord, key: string): boolean {
  const candidate = value(row, key);
  if (typeof candidate !== "boolean")
    throw new ApiError(
      503,
      "service_unavailable",
      "Stored sync data is malformed.",
    );
  return candidate;
}

function storedDevice(row: RowRecord): RegisteredDeviceRecord {
  const protocolVersion = integerValue(row, "protocolVersion");
  const status = stringValue(row, "status");
  if (
    protocolVersion !== 1 ||
    (status !== "pending" && status !== "active" && status !== "revoked")
  ) {
    throw new ApiError(
      503,
      "service_unavailable",
      "Stored device data is malformed.",
    );
  }
  const revokedAt = row.revokedAt;
  return {
    protocolVersion,
    accountId: stringValue(row, "accountId"),
    deviceId: stringValue(row, "deviceId"),
    encryptionPublicKey: stringValue(row, "encryptionPublicKey"),
    signingPublicKey: stringValue(row, "signingPublicKey"),
    status,
    createdAt: stringValue(row, "createdAt"),
    updatedAt: stringValue(row, "updatedAt"),
    ...(typeof revokedAt === "string" ? { revokedAt } : {}),
  };
}

function storedChallenge(row: RowRecord): StoredDeviceApprovalChallenge {
  const protocolVersion = integerValue(row, "protocolVersion");
  const status = stringValue(row, "status");
  if (
    protocolVersion !== 1 ||
    (status !== "pending" && status !== "consumed")
  ) {
    throw new ApiError(
      503,
      "service_unavailable",
      "Stored approval challenge is malformed.",
    );
  }
  const consumedAt = row.consumedAt;
  const approverDeviceId = row.approverDeviceId;
  return {
    challengeId: row.$id,
    protocolVersion,
    notebookId: stringValue(row, "notebookId"),
    accountId: stringValue(row, "accountId"),
    requestingDeviceId: stringValue(row, "requestingDeviceId"),
    requestingEncryptionPublicKey: stringValue(
      row,
      "requestingEncryptionPublicKey",
    ),
    requestingSigningPublicKey: stringValue(row, "requestingSigningPublicKey"),
    nonce: stringValue(row, "nonce"),
    issuedAt: integerValue(row, "issuedAt"),
    expiresAt: integerValue(row, "expiresAt"),
    status,
    ...(typeof consumedAt === "string" ? { consumedAt } : {}),
    ...(typeof approverDeviceId === "string" ? { approverDeviceId } : {}),
  };
}

function publicChallenge(
  challenge: StoredDeviceApprovalChallenge,
): DeviceApprovalChallenge {
  return {
    protocolVersion: challenge.protocolVersion,
    notebookId: challenge.notebookId,
    accountId: challenge.accountId,
    requestingDeviceId: challenge.requestingDeviceId,
    requestingEncryptionPublicKey: challenge.requestingEncryptionPublicKey,
    requestingSigningPublicKey: challenge.requestingSigningPublicKey,
    nonce: challenge.nonce,
    issuedAt: challenge.issuedAt,
    expiresAt: challenge.expiresAt,
  };
}

function publicDevice(device: RegisteredDeviceRecord): RegisteredDevice {
  return {
    protocolVersion: device.protocolVersion,
    deviceId: device.deviceId,
    encryptionPublicKey: device.encryptionPublicKey,
    signingPublicKey: device.signingPublicKey,
    status: device.status,
    createdAt: device.createdAt,
    updatedAt: device.updatedAt,
    ...(device.revokedAt === undefined ? {} : { revokedAt: device.revokedAt }),
  };
}

function storedKeyEnvelope(
  row: RowRecord,
  senderSigningPublicKey: string,
): StoredKeyEnvelope {
  const protocolVersion = integerValue(row, "protocolVersion");
  const recipientKind = stringValue(row, "recipientKind");
  if (
    protocolVersion !== 1 ||
    (recipientKind !== "account" &&
      recipientKind !== "device" &&
      recipientKind !== "recovery")
  ) {
    throw new ApiError(
      503,
      "service_unavailable",
      "Stored key-envelope data is malformed.",
    );
  }
  return {
    envelopeId: row.$id,
    senderSigningPublicKey,
    protocolVersion,
    notebookId: stringValue(row, "notebookId"),
    keyEpoch: integerValue(row, "keyEpoch"),
    senderDeviceId: stringValue(row, "senderDeviceId"),
    recipient: { kind: recipientKind, id: stringValue(row, "recipientId") },
    senderEncryptionPublicKey: stringValue(row, "senderEncryptionPublicKey"),
    recipientEncryptionPublicKey: stringValue(
      row,
      "recipientEncryptionPublicKey",
    ),
    ...(recipientKind === "recovery"
      ? {
          recoverySigningPublicKey: stringValue(
            row,
            "recoverySigningPublicKey",
          ),
        }
      : {}),
    nonce: stringValue(row, "nonce"),
    ciphertext: stringValue(row, "ciphertext"),
    signature: stringValue(row, "signature"),
    envelopeHash: stringValue(row, "envelopeHash"),
  };
}

function storedChange(row: RowRecord): CommittedChangeEnvelope {
  const protocolVersion = integerValue(row, "protocolVersion");
  if (protocolVersion !== 1)
    throw new ApiError(
      503,
      "service_unavailable",
      "Stored sync data has an unsupported version.",
    );
  return {
    protocolVersion,
    notebookId: stringValue(row, "notebookId"),
    documentId: stringValue(row, "documentId"),
    deviceId: stringValue(row, "deviceId"),
    keyEpoch: integerValue(row, "keyEpoch"),
    sequence: integerValue(row, "sequence"),
    changeHash: stringValue(row, "changeHash"),
    nonce: stringValue(row, "nonce"),
    ciphertext: stringValue(row, "ciphertext"),
    signature: stringValue(row, "signature"),
  };
}

function samePending(
  left: CommittedChangeEnvelope,
  right: PendingChangeEnvelope,
): boolean {
  return (
    left.protocolVersion === right.protocolVersion &&
    left.notebookId === right.notebookId &&
    left.documentId === right.documentId &&
    left.deviceId === right.deviceId &&
    left.keyEpoch === right.keyEpoch &&
    left.changeHash === right.changeHash &&
    left.nonce === right.nonce &&
    left.ciphertext === right.ciphertext &&
    left.signature === right.signature
  );
}

function teamRead(notebookId: string): string {
  return `read("team:${notebookId}")`;
}

function userRead(userId: string): string {
  return `read("user:${userId}")`;
}

function assetNotebookQuotaId(notebookId: string): string {
  return deterministicId("aqn", notebookId);
}

function assetDeviceQuotaId(notebookId: string, deviceId: string): string {
  return deterministicId("aqd", notebookId, deviceId);
}

function sameAssetReservation(
  reservation: AssetReservation,
  request: BeginAssetUpload,
): boolean {
  return (
    reservation.protocolVersion === request.protocolVersion &&
    reservation.notebookId === request.notebookId &&
    reservation.deviceId === request.deviceId &&
    reservation.encryptedHash === request.encryptedHash &&
    reservation.encryptedSize === request.encryptedSize &&
    reservation.uploadSignature === request.uploadSignature
  );
}

const APPROVAL_LIFETIME_MS = 5 * 60 * 1000;
const MAX_LIVE_DEVICE_CHALLENGES = 3;

async function defaultRetryDelay(attempt: number): Promise<void> {
  await new Promise((resolve) =>
    setTimeout(resolve, Math.min(10 * 2 ** attempt, 160)),
  );
}

export class AppwriteSyncRepository implements SyncRepository {
  private readonly now: () => Date;
  private readonly retryDelay: (attempt: number) => Promise<void>;

  constructor(
    private readonly data: AppwriteDataPort,
    private readonly encryptedAssets: EncryptedAssetPort,
    options: RepositoryOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.retryDelay = options.retryDelay ?? defaultRetryDelay;
  }

  private async rollbackQuietly(transactionId: string): Promise<void> {
    try {
      await this.data.rollbackTransaction(transactionId);
    } catch {
      // Expired, committed, and already-rolled-back transactions need no further action.
    }
  }

  private async existingChange(rowId: string, envelope: PendingChangeEnvelope) {
    const existing = await this.data.getRow(RESOURCE_IDS.changes, rowId);
    if (existing === null) return null;
    const committed = storedChange(existing);
    if (!samePending(committed, envelope))
      conflict("The idempotency key is already bound to a different envelope.");
    return { envelope: committed, duplicate: true } as const;
  }

  async registerDevice(accountId: string, request: RegisterDeviceRequest) {
    const rowId = deterministicId("dev", request.deviceId);
    const existing = await this.data.getRow(RESOURCE_IDS.devices, rowId);
    if (existing !== null) {
      const device = storedDevice(existing);
      if (
        device.accountId !== accountId ||
        device.deviceId !== request.deviceId ||
        device.encryptionPublicKey !== request.encryptionPublicKey ||
        device.signingPublicKey !== request.signingPublicKey
      ) {
        conflict(
          "The device identity is already bound to another account or public key.",
        );
      }
      return {
        device: publicDevice(device),
        duplicate: true,
        bootstrap: booleanValue(existing, "bootstrap"),
      };
    }

    const accountRowId = deterministicId("dac", accountId);
    for (let attempt = 0; attempt < LIMITS.transactionRetries; attempt += 1) {
      const timestamp = this.now().toISOString();
      const transactionId = await this.data.createTransaction(30);
      try {
        const accountState = await this.data.getRow(
          RESOURCE_IDS.deviceAccounts,
          accountRowId,
          transactionId,
        );
        const bootstrap = accountState === null;
        if (bootstrap) {
          await this.data.createRow(
            RESOURCE_IDS.deviceAccounts,
            accountRowId,
            {
              accountId,
              bootstrapDeviceId: request.deviceId,
              createdAt: timestamp,
            },
            [],
            transactionId,
          );
        }
        await this.data.createRow(
          RESOURCE_IDS.devices,
          rowId,
          {
            ...request,
            accountId,
            status: bootstrap ? "active" : "pending",
            bootstrap,
            challengeVersion: 0,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
          [userRead(accountId)],
          transactionId,
        );
        await this.data.commitTransaction(transactionId);
        const created = await this.data.getRow(RESOURCE_IDS.devices, rowId);
        if (created === null)
          throw new ApiError(
            503,
            "service_unavailable",
            "Registered device could not be read back.",
          );
        return {
          device: publicDevice(storedDevice(created)),
          duplicate: false,
          bootstrap,
        };
      } catch (error) {
        await this.rollbackQuietly(transactionId);
        const reconciled = await this.data.getRow(RESOURCE_IDS.devices, rowId);
        if (reconciled !== null) {
          const device = storedDevice(reconciled);
          if (
            device.accountId !== accountId ||
            device.deviceId !== request.deviceId ||
            device.encryptionPublicKey !== request.encryptionPublicKey ||
            device.signingPublicKey !== request.signingPublicKey
          ) {
            conflict(
              "The device identity is already bound to another account or public key.",
            );
          }
          return {
            device: publicDevice(device),
            duplicate: true,
            bootstrap: booleanValue(reconciled, "bootstrap"),
          };
        }
        if (!isCode(error, 409) || attempt === LIMITS.transactionRetries - 1)
          throw error;
        await this.retryDelay(attempt);
      }
    }
    throw new ApiError(
      503,
      "service_unavailable",
      "Device registration did not converge.",
    );
  }

  async getDevice(deviceId: string): Promise<RegisteredDeviceRecord | null> {
    const row = await this.data.getRow(
      RESOURCE_IDS.devices,
      deterministicId("dev", deviceId),
    );
    if (row === null) return null;
    const device = storedDevice(row);
    if (device.deviceId !== deviceId) {
      throw new ApiError(
        503,
        "service_unavailable",
        "Stored device identity is inconsistent.",
      );
    }
    return device;
  }

  async listMyDevices(accountId: string, request: ListMyDevicesRequest) {
    const rows = await this.data.listRows(RESOURCE_IDS.devices, {
      equal: { accountId },
      orderAsc: "$id",
      limit: request.limit + 1,
      ...(request.cursor === undefined ? {} : { cursorAfter: request.cursor }),
    });
    const selected = rows.slice(0, request.limit);
    const nextCursor =
      rows.length > request.limit ? selected.at(-1)?.$id : undefined;
    return {
      devices: selected.map((row) => publicDevice(storedDevice(row))),
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  }

  async listNotebookDevices(
    accountIds: readonly string[],
    request: ListNotebookDevicesRequest,
  ) {
    if (accountIds.length === 0) return { devices: [] };
    const rows = await this.data.listRows(RESOURCE_IDS.devices, {
      equal: { accountId: [...accountIds], status: "active" },
      orderAsc: "$id",
      limit: request.limit + 1,
      ...(request.cursor === undefined ? {} : { cursorAfter: request.cursor }),
    });
    const selected = rows.slice(0, request.limit);
    const nextCursor =
      rows.length > request.limit ? selected.at(-1)?.$id : undefined;
    return {
      devices: selected.map((row) => publicDevice(storedDevice(row))),
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  }

  async revokeDevice(deviceId: string) {
    const rowId = deterministicId("dev", deviceId);
    const existing = await this.data.getRow(RESOURCE_IDS.devices, rowId);
    if (existing === null)
      throw new ApiError(404, "not_found", "Device was not found.");
    const device = storedDevice(existing);
    if (device.deviceId !== deviceId)
      conflict("Stored device identity does not match.");
    if (device.status === "revoked")
      return { device: publicDevice(device), duplicate: true };

    const revokedAt = this.now().toISOString();
    const transactionId = await this.data.createTransaction(30);
    try {
      const current = await this.data.getRow(
        RESOURCE_IDS.devices,
        rowId,
        transactionId,
      );
      if (current === null)
        throw new ApiError(404, "not_found", "Device was not found.");
      const currentDevice = storedDevice(current);
      if (currentDevice.status === "revoked") {
        await this.rollbackQuietly(transactionId);
        return { device: publicDevice(currentDevice), duplicate: true };
      }
      await this.data.updateRow(
        RESOURCE_IDS.devices,
        rowId,
        { status: "revoked", revokedAt, updatedAt: revokedAt },
        undefined,
        transactionId,
      );
      await this.data.commitTransaction(transactionId);
    } catch (error) {
      await this.rollbackQuietly(transactionId);
      const reconciled = await this.data.getRow(RESOURCE_IDS.devices, rowId);
      if (
        reconciled !== null &&
        storedDevice(reconciled).status === "revoked"
      ) {
        return {
          device: publicDevice(storedDevice(reconciled)),
          duplicate: true,
        };
      }
      throw error;
    }
    const revoked = await this.data.getRow(RESOURCE_IDS.devices, rowId);
    if (revoked === null)
      throw new ApiError(
        503,
        "service_unavailable",
        "Revoked device could not be read back.",
      );
    return { device: publicDevice(storedDevice(revoked)), duplicate: false };
  }

  async createDeviceApprovalChallenge(
    accountId: string,
    request: CreateDeviceApprovalChallengeRequest,
  ) {
    const deviceRowId = deterministicId("dev", request.requestingDeviceId);
    for (let attempt = 0; attempt < LIMITS.transactionRetries; attempt += 1) {
      const transactionId = await this.data.createTransaction(30);
      try {
        const deviceRow = await this.data.getRow(
          RESOURCE_IDS.devices,
          deviceRowId,
          transactionId,
        );
        if (deviceRow === null)
          throw new ApiError(404, "not_found", "Pending device was not found.");
        const device = storedDevice(deviceRow);
        if (device.accountId !== accountId || device.status !== "pending") {
          throw new ApiError(
            409,
            "conflict",
            "Only a pending device for the current account may request approval.",
          );
        }
        const now = this.now().getTime();
        const live = await this.data.listRows(
          RESOURCE_IDS.deviceChallenges,
          {
            equal: {
              accountId,
              requestingDeviceId: request.requestingDeviceId,
              status: "pending",
            },
            greaterThan: { expiresAt: now },
            orderAsc: "expiresAt",
            limit: MAX_LIVE_DEVICE_CHALLENGES,
          },
          transactionId,
        );
        if (live.length >= MAX_LIVE_DEVICE_CHALLENGES) {
          throw new ApiError(
            429,
            "too_many_challenges",
            "The pending device already has enough live challenges.",
          );
        }
        const issuedAt = now;
        const expiresAt = issuedAt + APPROVAL_LIFETIME_MS;
        const nonce = randomBytes(32).toString("base64url");
        const challengeId = deterministicId(
          "apr",
          accountId,
          request.requestingDeviceId,
          nonce,
        );
        const challenge: DeviceApprovalChallenge = {
          protocolVersion: request.protocolVersion,
          notebookId: request.notebookId,
          accountId,
          requestingDeviceId: request.requestingDeviceId,
          requestingEncryptionPublicKey: device.encryptionPublicKey,
          requestingSigningPublicKey: device.signingPublicKey,
          nonce,
          issuedAt,
          expiresAt,
        };
        await this.data.updateRow(
          RESOURCE_IDS.devices,
          deviceRowId,
          { challengeVersion: integerValue(deviceRow, "challengeVersion") + 1 },
          undefined,
          transactionId,
        );
        await this.data.createRow(
          RESOURCE_IDS.deviceChallenges,
          challengeId,
          { ...challenge, status: "pending" },
          [],
          transactionId,
        );
        await this.data.commitTransaction(transactionId);
        return { challengeId, challenge };
      } catch (error) {
        await this.rollbackQuietly(transactionId);
        if (
          error instanceof ApiError ||
          !isCode(error, 409) ||
          attempt === LIMITS.transactionRetries - 1
        ) {
          throw error;
        }
        await this.retryDelay(attempt);
      }
    }
    throw new ApiError(
      503,
      "service_unavailable",
      "Approval challenge creation did not converge.",
    );
  }

  async getDeviceApprovalChallenge(
    challengeId: string,
  ): Promise<StoredDeviceApprovalChallenge | null> {
    const row = await this.data.getRow(
      RESOURCE_IDS.deviceChallenges,
      challengeId,
    );
    return row === null ? null : storedChallenge(row);
  }

  async activateDevice(accountId: string, request: ActivateDeviceRequest) {
    const transactionId = await this.data.createTransaction(30);
    try {
      const challengeRow = await this.data.getRow(
        RESOURCE_IDS.deviceChallenges,
        request.challengeId,
        transactionId,
      );
      if (challengeRow === null)
        throw new ApiError(
          404,
          "not_found",
          "Approval challenge was not found.",
        );
      const challenge = storedChallenge(challengeRow);
      if (challenge.accountId !== accountId) {
        throw new ApiError(
          403,
          "forbidden",
          "Approval challenge belongs to another account.",
        );
      }
      const deviceRowId = deterministicId("dev", challenge.requestingDeviceId);
      const approverRowId = deterministicId(
        "dev",
        request.proof.approverDeviceId,
      );
      const deviceRow = await this.data.getRow(
        RESOURCE_IDS.devices,
        deviceRowId,
        transactionId,
      );
      const approverRow = await this.data.getRow(
        RESOURCE_IDS.devices,
        approverRowId,
        transactionId,
      );
      if (deviceRow === null || approverRow === null) {
        throw new ApiError(
          409,
          "conflict",
          "Approval devices are unavailable.",
        );
      }
      const device = storedDevice(deviceRow);
      const approver = storedDevice(approverRow);
      const exactConsumedProof =
        challengeRow.proofChallengeHash === request.proof.challengeHash &&
        challengeRow.approvalSignature === request.proof.signature &&
        challengeRow.approvalKind === "device" &&
        challenge.approverDeviceId === request.proof.approverDeviceId;
      if (challenge.status === "consumed") {
        if (exactConsumedProof && device.status === "active") {
          await this.rollbackQuietly(transactionId);
          return { device: publicDevice(device), duplicate: true };
        }
        conflict(
          "Approval challenge has already been consumed by another proof.",
        );
      }
      if (this.now().getTime() > challenge.expiresAt) {
        throw new ApiError(
          409,
          "approval_expired",
          "Approval challenge has expired.",
        );
      }
      if (
        device.accountId !== accountId ||
        device.status !== "pending" ||
        device.encryptionPublicKey !==
          challenge.requestingEncryptionPublicKey ||
        device.signingPublicKey !== challenge.requestingSigningPublicKey
      ) {
        conflict("Pending device no longer matches the approval challenge.");
      }
      if (
        approver.accountId !== accountId ||
        approver.status !== "active" ||
        approver.deviceId === device.deviceId
      ) {
        throw new ApiError(
          403,
          "forbidden",
          "Approver must be another active device on the same account.",
        );
      }
      verifyApprovalProof(
        publicChallenge(challenge),
        request.proof,
        approver.signingPublicKey,
      );
      const consumedAt = this.now().toISOString();
      await this.data.updateRow(
        RESOURCE_IDS.deviceChallenges,
        request.challengeId,
        {
          status: "consumed",
          consumedAt,
          approvalKind: "device",
          approverDeviceId: approver.deviceId,
          proofChallengeHash: request.proof.challengeHash,
          approvalSignature: request.proof.signature,
        },
        undefined,
        transactionId,
      );
      await this.data.updateRow(
        RESOURCE_IDS.devices,
        deviceRowId,
        { status: "active", updatedAt: consumedAt },
        undefined,
        transactionId,
      );
      await this.data.commitTransaction(transactionId);
      const activated = await this.data.getRow(
        RESOURCE_IDS.devices,
        deviceRowId,
      );
      if (activated === null)
        throw new ApiError(
          503,
          "service_unavailable",
          "Activated device could not be read back.",
        );
      return {
        device: publicDevice(storedDevice(activated)),
        duplicate: false,
      };
    } catch (error) {
      await this.rollbackQuietly(transactionId);
      const challengeRow = await this.data.getRow(
        RESOURCE_IDS.deviceChallenges,
        request.challengeId,
      );
      if (challengeRow !== null) {
        const challenge = storedChallenge(challengeRow);
        const device = await this.getDevice(challenge.requestingDeviceId);
        if (
          challenge.status === "consumed" &&
          challengeRow.proofChallengeHash === request.proof.challengeHash &&
          challengeRow.approvalSignature === request.proof.signature &&
          challengeRow.approvalKind === "device" &&
          challenge.approverDeviceId === request.proof.approverDeviceId &&
          device?.status === "active"
        ) {
          return { device: publicDevice(device), duplicate: true };
        }
      }
      throw error;
    }
  }

  async activateDeviceWithRecovery(
    accountId: string,
    request: ActivateDeviceWithRecoveryRequest,
  ) {
    const transactionId = await this.data.createTransaction(30);
    try {
      const challengeRow = await this.data.getRow(
        RESOURCE_IDS.deviceChallenges,
        request.challengeId,
        transactionId,
      );
      if (challengeRow === null)
        throw new ApiError(
          404,
          "not_found",
          "Approval challenge was not found.",
        );
      const challenge = storedChallenge(challengeRow);
      if (challenge.accountId !== accountId) {
        throw new ApiError(
          403,
          "forbidden",
          "Approval challenge belongs to another account.",
        );
      }
      const deviceRowId = deterministicId("dev", challenge.requestingDeviceId);
      const deviceRow = await this.data.getRow(
        RESOURCE_IDS.devices,
        deviceRowId,
        transactionId,
      );
      if (deviceRow === null)
        throw new ApiError(409, "conflict", "Pending device is unavailable.");
      const device = storedDevice(deviceRow);
      const exactConsumedProof =
        challengeRow.proofChallengeHash === request.proof.challengeHash &&
        challengeRow.approvalSignature === request.proof.signature &&
        challengeRow.approvalKind === "recovery" &&
        challengeRow.recoveryKeyId === request.proof.recoveryKeyId;
      if (challenge.status === "consumed") {
        if (exactConsumedProof && device.status === "active") {
          await this.rollbackQuietly(transactionId);
          return { device: publicDevice(device), duplicate: true };
        }
        conflict(
          "Approval challenge has already been consumed by another proof.",
        );
      }
      if (this.now().getTime() > challenge.expiresAt) {
        throw new ApiError(
          409,
          "approval_expired",
          "Approval challenge has expired.",
        );
      }
      if (
        device.accountId !== accountId ||
        device.status !== "pending" ||
        device.encryptionPublicKey !==
          challenge.requestingEncryptionPublicKey ||
        device.signingPublicKey !== challenge.requestingSigningPublicKey
      ) {
        conflict("Pending device no longer matches the approval challenge.");
      }

      const recoveryRows = await this.data.listRows(
        RESOURCE_IDS.keyEnvelopes,
        {
          equal: {
            notebookId: challenge.notebookId,
            recipientKind: "recovery",
            recipientId: request.proof.recoveryKeyId,
          },
          orderAsc: "keyEpoch",
          limit: 101,
        },
        transactionId,
      );
      if (recoveryRows.length === 0) {
        throw new ApiError(
          400,
          "invalid_approval",
          "Recovery approval key is not registered for this notebook.",
        );
      }
      if (recoveryRows.length > 100) {
        conflict(
          "Recovery approval key history exceeds the verification bound.",
        );
      }
      const signingKeys = new Set(
        recoveryRows.map((row) => stringValue(row, "recoverySigningPublicKey")),
      );
      if (signingKeys.size !== 1)
        conflict("Recovery approval key history is inconsistent.");
      const recoverySigningPublicKey = [...signingKeys][0];
      if (recoverySigningPublicKey === undefined) {
        throw new ApiError(
          503,
          "service_unavailable",
          "Recovery approval key could not be resolved.",
        );
      }
      verifyRecoveryApprovalProof(
        publicChallenge(challenge),
        request.proof,
        recoverySigningPublicKey,
      );

      const consumedAt = this.now().toISOString();
      await this.data.updateRow(
        RESOURCE_IDS.deviceChallenges,
        request.challengeId,
        {
          status: "consumed",
          consumedAt,
          approvalKind: "recovery",
          recoveryKeyId: request.proof.recoveryKeyId,
          proofChallengeHash: request.proof.challengeHash,
          approvalSignature: request.proof.signature,
        },
        undefined,
        transactionId,
      );
      await this.data.updateRow(
        RESOURCE_IDS.devices,
        deviceRowId,
        { status: "active", updatedAt: consumedAt },
        undefined,
        transactionId,
      );
      await this.data.commitTransaction(transactionId);
      const activated = await this.data.getRow(
        RESOURCE_IDS.devices,
        deviceRowId,
      );
      if (activated === null)
        throw new ApiError(
          503,
          "service_unavailable",
          "Activated device could not be read back.",
        );
      return {
        device: publicDevice(storedDevice(activated)),
        duplicate: false,
      };
    } catch (error) {
      await this.rollbackQuietly(transactionId);
      const challengeRow = await this.data.getRow(
        RESOURCE_IDS.deviceChallenges,
        request.challengeId,
      );
      if (challengeRow !== null) {
        const challenge = storedChallenge(challengeRow);
        const device = await this.getDevice(challenge.requestingDeviceId);
        if (
          challenge.status === "consumed" &&
          challengeRow.proofChallengeHash === request.proof.challengeHash &&
          challengeRow.approvalSignature === request.proof.signature &&
          challengeRow.approvalKind === "recovery" &&
          challengeRow.recoveryKeyId === request.proof.recoveryKeyId &&
          device?.status === "active"
        ) {
          return { device: publicDevice(device), duplicate: true };
        }
      }
      throw error;
    }
  }

  async listKeyEnvelopes(request: ListKeyEnvelopesRequest) {
    const rows = await this.data.listRows(RESOURCE_IDS.keyEnvelopes, {
      equal: {
        notebookId: request.notebookId,
        recipientKind: request.recipient.kind,
        recipientId: request.recipient.id,
      },
      orderAsc: "keyEpoch",
      limit: request.limit + 1,
      ...(request.cursor === undefined ? {} : { cursorAfter: request.cursor }),
    });
    const selected = rows.slice(0, request.limit);
    const nextCursor =
      rows.length > request.limit ? selected.at(-1)?.$id : undefined;
    const envelopes = await Promise.all(
      selected.map(async (row) => {
        const senderDeviceId = stringValue(row, "senderDeviceId");
        const sender = await this.getDevice(senderDeviceId);
        if (sender === null) {
          throw new ApiError(
            503,
            "service_unavailable",
            "Key-envelope sender device is unavailable.",
          );
        }
        return storedKeyEnvelope(row, sender.signingPublicKey);
      }),
    );
    return {
      envelopes,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  }

  async appendChange(envelope: PendingChangeEnvelope, createdBy: string) {
    const rowId = deterministicId(
      "chg",
      envelope.notebookId,
      envelope.deviceId,
      envelope.changeHash,
    );
    const prior = await this.existingChange(rowId, envelope);
    if (prior) return prior;

    for (let attempt = 0; attempt < LIMITS.transactionRetries; attempt += 1) {
      const transactionId = await this.data.createTransaction(30);
      try {
        const counter = await this.data.getRow(
          RESOURCE_IDS.notebooks,
          envelope.notebookId,
          transactionId,
        );
        const sequence =
          counter === null ? 1 : integerValue(counter, "currentSequence") + 1;
        if (!Number.isSafeInteger(sequence))
          conflict("The notebook sequence is exhausted.");

        if (counter === null) {
          await this.data.createRow(
            RESOURCE_IDS.notebooks,
            envelope.notebookId,
            { currentSequence: sequence, createdBy },
            [],
            transactionId,
          );
        } else {
          await this.data.updateRow(
            RESOURCE_IDS.notebooks,
            envelope.notebookId,
            { currentSequence: sequence },
            undefined,
            transactionId,
          );
        }
        await this.data.createRow(
          RESOURCE_IDS.changes,
          rowId,
          { ...envelope, sequence },
          [teamRead(envelope.notebookId)],
          transactionId,
        );
        await this.data.commitTransaction(transactionId);

        const committed = await this.data.getRow(RESOURCE_IDS.changes, rowId);
        if (committed === null)
          throw new ApiError(
            503,
            "service_unavailable",
            "Committed change could not be read back.",
          );
        return { envelope: storedChange(committed), duplicate: false };
      } catch (error) {
        await this.rollbackQuietly(transactionId);
        const reconciled = await this.existingChange(rowId, envelope);
        if (reconciled) return reconciled;
        if (!isCode(error, 409) || attempt === LIMITS.transactionRetries - 1)
          throw error;
        await this.retryDelay(attempt);
      }
    }
    throw new ApiError(
      503,
      "service_unavailable",
      "Sequence allocation did not converge.",
    );
  }

  async listChangesAfter(
    notebookId: string,
    afterSequence: number,
    limit: number,
  ): Promise<CatchUpPage> {
    const transactionId = await this.data.createTransaction(15);
    try {
      const counter = await this.data.getRow(
        RESOURCE_IDS.notebooks,
        notebookId,
        transactionId,
      );
      const snapshotSequence =
        counter === null ? 0 : integerValue(counter, "currentSequence");
      const rows = await this.data.listRows(
        RESOURCE_IDS.changes,
        {
          equal: { notebookId },
          greaterThan: { sequence: afterSequence },
          orderAsc: "sequence",
          limit: limit + 1,
        },
        transactionId,
      );
      const envelopes = rows.slice(0, limit).map(storedChange);
      const lastSequence = envelopes.at(-1)?.sequence ?? afterSequence;
      return {
        notebookId,
        afterSequence,
        snapshotSequence,
        hasMore: rows.length > limit || lastSequence < snapshotSequence,
        envelopes,
      };
    } finally {
      await this.rollbackQuietly(transactionId);
    }
  }

  async acknowledgeHeads(
    acknowledgement: HeadsAcknowledgement,
  ): Promise<{ accepted: number; sequence: number }> {
    const normalizedDocuments = acknowledgement.documents.map((document) => ({
      ...document,
      heads: [...document.heads].sort(),
    }));

    for (let attempt = 0; attempt < LIMITS.transactionRetries; attempt += 1) {
      const transactionId = await this.data.createTransaction(30);
      try {
        const counter = await this.data.getRow(
          RESOURCE_IDS.notebooks,
          acknowledgement.notebookId,
          transactionId,
        );
        const currentSequence =
          counter === null ? 0 : integerValue(counter, "currentSequence");
        if (acknowledgement.sequence > currentSequence)
          conflict("Heads cannot acknowledge an uncommitted sequence.");
        let accepted = 0;

        for (const document of normalizedDocuments) {
          const rowId = deterministicId(
            "hed",
            acknowledgement.notebookId,
            acknowledgement.deviceId,
            document.documentId,
          );
          const existing = await this.data.getRow(
            RESOURCE_IDS.heads,
            rowId,
            transactionId,
          );
          const heads = JSON.stringify(document.heads);
          if (existing !== null) {
            const previousSequence = integerValue(existing, "sequence");
            const previousHeads = stringValue(existing, "heads");
            if (previousSequence > acknowledgement.sequence)
              conflict("Heads acknowledgement is older than stored state.");
            if (previousSequence === acknowledgement.sequence) {
              if (previousHeads !== heads)
                conflict(
                  "The same heads sequence cannot be rebound to different heads.",
                );
              continue;
            }
            await this.data.updateRow(
              RESOURCE_IDS.heads,
              rowId,
              { sequence: acknowledgement.sequence, heads },
              undefined,
              transactionId,
            );
          } else {
            await this.data.createRow(
              RESOURCE_IDS.heads,
              rowId,
              {
                protocolVersion: acknowledgement.protocolVersion,
                notebookId: acknowledgement.notebookId,
                documentId: document.documentId,
                deviceId: acknowledgement.deviceId,
                sequence: acknowledgement.sequence,
                heads,
              },
              [],
              transactionId,
            );
          }
          accepted += 1;
        }
        await this.data.commitTransaction(transactionId);
        return { accepted, sequence: acknowledgement.sequence };
      } catch (error) {
        await this.rollbackQuietly(transactionId);
        if (
          !isCode(error, 409) ||
          error instanceof ApiError ||
          attempt === LIMITS.transactionRetries - 1
        )
          throw error;
        await this.retryDelay(attempt);
      }
    }
    throw new ApiError(
      503,
      "service_unavailable",
      "Heads acknowledgement did not converge.",
    );
  }

  async putKeyEnvelope(
    envelope: NotebookKeyEnvelope,
  ): Promise<{ envelopeId: string; duplicate: boolean }> {
    const envelopeId = deterministicId(
      "key",
      envelope.notebookId,
      String(envelope.keyEpoch),
      envelope.recipient.kind,
      envelope.recipient.id,
    );
    const expected = {
      protocolVersion: envelope.protocolVersion,
      notebookId: envelope.notebookId,
      keyEpoch: envelope.keyEpoch,
      senderDeviceId: envelope.senderDeviceId,
      recipientKind: envelope.recipient.kind,
      recipientId: envelope.recipient.id,
      senderEncryptionPublicKey: envelope.senderEncryptionPublicKey,
      recipientEncryptionPublicKey: envelope.recipientEncryptionPublicKey,
      ...(envelope.recoverySigningPublicKey === undefined
        ? {}
        : { recoverySigningPublicKey: envelope.recoverySigningPublicKey }),
      nonce: envelope.nonce,
      ciphertext: envelope.ciphertext,
      signature: envelope.signature,
      envelopeHash: envelope.envelopeHash,
    };
    const existing = await this.data.getRow(
      RESOURCE_IDS.keyEnvelopes,
      envelopeId,
    );
    if (existing !== null) {
      for (const [key, candidate] of Object.entries(expected)) {
        if (existing[key] !== candidate)
          conflict(
            "The key-envelope slot is already bound to different bytes.",
          );
      }
      return { envelopeId, duplicate: true };
    }

    const transactionId = await this.data.createTransaction(30);
    try {
      await this.data.createRow(
        RESOURCE_IDS.keyEnvelopes,
        envelopeId,
        expected,
        [],
        transactionId,
      );
      await this.data.commitTransaction(transactionId);
      return { envelopeId, duplicate: false };
    } catch (error) {
      await this.rollbackQuietly(transactionId);
      const reconciled = await this.data.getRow(
        RESOURCE_IDS.keyEnvelopes,
        envelopeId,
      );
      if (reconciled !== null) {
        for (const [key, candidate] of Object.entries(expected)) {
          if (reconciled[key] !== candidate)
            conflict(
              "The key-envelope slot is already bound to different bytes.",
            );
        }
        return { envelopeId, duplicate: true };
      }
      throw error;
    }
  }

  private storedReservation(row: RowRecord): AssetReservation {
    const status = stringValue(row, "status");
    if (
      status !== "pending" &&
      status !== "uploading" &&
      status !== "cleaning" &&
      status !== "complete"
    ) {
      throw new ApiError(
        503,
        "service_unavailable",
        "Stored asset state is malformed.",
      );
    }
    const completedAt = row.completedAt;
    const leaseExpiresAt = row.leaseExpiresAt;
    return {
      assetId: row.$id,
      protocolVersion: integerValue(row, "protocolVersion") as 1,
      notebookId: stringValue(row, "notebookId"),
      deviceId: stringValue(row, "deviceId"),
      fileId: stringValue(row, "fileId"),
      encryptedHash: stringValue(row, "encryptedHash"),
      encryptedSize: integerValue(row, "encryptedSize"),
      uploadSignature: stringValue(row, "uploadSignature"),
      chunkCount: integerValue(row, "chunkCount"),
      bucketId: RESOURCE_IDS.assetBucket,
      status,
      expiresAt: stringValue(row, "expiresAt"),
      ...(typeof leaseExpiresAt === "string" ? { leaseExpiresAt } : {}),
      ...(typeof completedAt === "string" ? { completedAt } : {}),
    };
  }

  private async reconcileAssetReservation(
    assetId: string,
    request: BeginAssetUpload,
  ): Promise<{ reservation: AssetReservation; duplicate: true } | null> {
    const row = await this.data.getRow(RESOURCE_IDS.assets, assetId);
    if (row === null) return null;
    const reservation = this.storedReservation(row);
    if (!sameAssetReservation(reservation, request)) {
      conflict(
        "The asset identity is already bound to different encrypted metadata.",
      );
    }
    return { reservation, duplicate: true };
  }

  private quotaCount(row: RowRecord | null): number {
    return row === null ? 0 : integerValue(row, "pendingCount");
  }

  private async writeQuota(
    transactionId: string,
    rowId: string,
    current: RowRecord | null,
    data: Record<string, unknown>,
    pendingCount: number,
  ): Promise<void> {
    if (current === null) {
      await this.data.createRow(
        RESOURCE_IDS.assetQuotas,
        rowId,
        { ...data, pendingCount },
        [],
        transactionId,
      );
    } else {
      await this.data.updateRow(
        RESOURCE_IDS.assetQuotas,
        rowId,
        { pendingCount },
        undefined,
        transactionId,
      );
    }
  }

  private async decrementAssetQuotas(
    transactionId: string,
    reservation: AssetReservation,
  ): Promise<void> {
    const notebookQuotaId = assetNotebookQuotaId(reservation.notebookId);
    const deviceQuotaId = assetDeviceQuotaId(
      reservation.notebookId,
      reservation.deviceId,
    );
    const notebookQuota = await this.data.getRow(
      RESOURCE_IDS.assetQuotas,
      notebookQuotaId,
      transactionId,
    );
    const deviceQuota = await this.data.getRow(
      RESOURCE_IDS.assetQuotas,
      deviceQuotaId,
      transactionId,
    );
    if (notebookQuota !== null) {
      await this.writeQuota(
        transactionId,
        notebookQuotaId,
        notebookQuota,
        { scope: "notebook", notebookId: reservation.notebookId },
        Math.max(0, this.quotaCount(notebookQuota) - 1),
      );
    }
    if (deviceQuota !== null) {
      await this.writeQuota(
        transactionId,
        deviceQuotaId,
        deviceQuota,
        {
          scope: "device",
          notebookId: reservation.notebookId,
          deviceId: reservation.deviceId,
        },
        Math.max(0, this.quotaCount(deviceQuota) - 1),
      );
    }
  }

  async beginAssetUpload(
    request: BeginAssetUpload,
  ): Promise<{ reservation: AssetReservation; duplicate: boolean }> {
    await this.cleanupExpiredAssetReservations();
    const assetId = deterministicId(
      "ast",
      request.notebookId,
      request.encryptedHash,
    );
    const fileId = assetId;
    const prior = await this.reconcileAssetReservation(assetId, request);
    if (prior) return prior;

    const expiresAt = new Date(
      this.now().getTime() + 24 * 60 * 60 * 1000,
    ).toISOString();
    const chunkCount = Math.ceil(request.encryptedSize / LIMITS.assetChunkBytes);
    const notebookQuotaId = assetNotebookQuotaId(request.notebookId);
    const deviceQuotaId = assetDeviceQuotaId(
      request.notebookId,
      request.deviceId,
    );
    for (
      let attempt = 0;
      attempt < LIMITS.assetTransactionRetries;
      attempt += 1
    ) {
      const transactionId = await this.data.createTransaction(30);
      try {
        const notebookQuota = await this.data.getRow(
          RESOURCE_IDS.assetQuotas,
          notebookQuotaId,
          transactionId,
        );
        const deviceQuota = await this.data.getRow(
          RESOURCE_IDS.assetQuotas,
          deviceQuotaId,
          transactionId,
        );
        const notebookPending = this.quotaCount(notebookQuota);
        const devicePending = this.quotaCount(deviceQuota);
        if (notebookPending >= LIMITS.pendingAssetsPerNotebook) {
        throw new ApiError(
          429,
          "rate_limited",
          "Notebook pending encrypted-asset quota is full.",
        );
        }
        if (devicePending >= LIMITS.pendingAssetsPerDevice) {
        throw new ApiError(
          429,
          "rate_limited",
          "Device pending encrypted-asset quota is full.",
        );
        }
        await this.writeQuota(
          transactionId,
          notebookQuotaId,
          notebookQuota,
          { scope: "notebook", notebookId: request.notebookId },
          notebookPending + 1,
        );
        await this.writeQuota(
          transactionId,
          deviceQuotaId,
          deviceQuota,
          {
            scope: "device",
            notebookId: request.notebookId,
            deviceId: request.deviceId,
          },
          devicePending + 1,
        );
        await this.data.createRow(
          RESOURCE_IDS.assets,
          assetId,
          { ...request, fileId, chunkCount, status: "pending", expiresAt },
          [],
          transactionId,
        );
        await this.data.commitTransaction(transactionId);
        const stored = await this.data.getRow(RESOURCE_IDS.assets, assetId);
        if (stored === null)
          throw new ApiError(
            503,
            "service_unavailable",
            "Asset reservation could not be read back.",
          );
        return {
          reservation: this.storedReservation(stored),
          duplicate: false,
        };
      } catch (error) {
        await this.rollbackQuietly(transactionId);
        const reconciled = await this.reconcileAssetReservation(
          assetId,
          request,
        );
        if (reconciled) return reconciled;
        if (
          !isCode(error, 409) ||
          error instanceof ApiError ||
          attempt === LIMITS.assetTransactionRetries - 1
        )
          throw error;
        await this.retryDelay(attempt);
      }
    }
    throw new ApiError(
      503,
      "service_unavailable",
      "Asset quota allocation did not converge.",
    );
  }

  async uploadAssetChunk(
    request: UploadAssetChunk,
  ): Promise<{ acceptedBytes: number; duplicate: boolean }> {
    const row = await this.data.getRow(RESOURCE_IDS.assets, request.assetId);
    if (row === null)
      throw new ApiError(404, "not_found", "Asset reservation was not found.");
    const reservation = this.storedReservation(row);
    if (
      !sameAssetReservation(reservation, request) ||
      reservation.fileId !== request.fileId ||
      reservation.chunkCount !== request.chunkCount
    )
      conflict("Asset chunk does not match its reservation.");
    if (reservation.status !== "pending")
      conflict("Asset reservation is not accepting chunks.");
    if (Date.parse(reservation.expiresAt) <= this.now().getTime())
      conflict("Asset reservation has expired.");
    if (
      request.chunkIndex < 0 ||
      request.chunkIndex >= reservation.chunkCount
    )
      conflict("Encrypted asset chunk index is outside its reservation.");
    const bytes = Buffer.from(request.chunkBytes, "base64url");
    const expectedSize =
      request.chunkIndex === reservation.chunkCount - 1
        ? request.encryptedSize -
          request.chunkIndex * LIMITS.assetChunkBytes
        : LIMITS.assetChunkBytes;
    if (bytes.byteLength !== expectedSize)
      conflict("Encrypted asset chunk has an invalid size.");
    const staged = await this.encryptedAssets.stageChunk(
      request.assetId,
      request.chunkIndex,
      bytes,
      request.chunkHash,
    );
    return { acceptedBytes: bytes.byteLength, duplicate: staged.duplicate };
  }

  async completeAssetUpload(
    request: CompleteAssetUpload,
  ): Promise<{ reservation: AssetReservation; duplicate: boolean }> {
    const row = await this.data.getRow(RESOURCE_IDS.assets, request.assetId);
    if (row === null)
      throw new ApiError(404, "not_found", "Asset reservation was not found.");
    const reservation = this.storedReservation(row);
    if (
      !sameAssetReservation(reservation, request) ||
      reservation.fileId !== request.fileId ||
      reservation.assetId !== request.assetId
    )
      conflict("Asset completion does not match its reservation.");
    if (reservation.status === "complete") {
      await this.encryptedAssets.removeStagedChunks(
        reservation.assetId,
        reservation.chunkCount,
      );
      return { reservation, duplicate: true };
    }
    if (reservation.status === "cleaning")
      conflict("Asset reservation is being cleaned.");
    if (
      reservation.status === "pending" &&
      Date.parse(reservation.expiresAt) <= this.now().getTime()
    )
      conflict("Asset reservation has expired.");

    if (
      reservation.status === "pending" ||
      reservation.status === "uploading"
    ) {
      const transactionId = await this.data.createTransaction(30);
      try {
        const current = await this.data.getRow(
          RESOURCE_IDS.assets,
          request.assetId,
          transactionId,
        );
        if (current === null)
          throw new ApiError(404, "not_found", "Asset reservation was not found.");
        const currentReservation = this.storedReservation(current);
        if (!sameAssetReservation(currentReservation, request))
          conflict("Asset completion does not match its reservation.");
        if (
          currentReservation.status === "pending" ||
          currentReservation.status === "uploading"
        ) {
          const leaseExpiresAt = new Date(
            this.now().getTime() + LIMITS.assetLeaseSeconds * 1000,
          ).toISOString();
          await this.data.updateRow(
            RESOURCE_IDS.assets,
            request.assetId,
            { status: "uploading", leaseExpiresAt },
            undefined,
            transactionId,
          );
          await this.data.commitTransaction(transactionId);
        } else {
          await this.rollbackQuietly(transactionId);
          if (currentReservation.status === "complete")
            return { reservation: currentReservation, duplicate: true };
          if (currentReservation.status === "cleaning")
            conflict("Asset reservation is being cleaned.");
        }
      } catch (error) {
        await this.rollbackQuietly(transactionId);
        throw error;
      }
    }

    const inspected = await this.encryptedAssets.assembleStagedChunks(
      request.fileId,
      request.assetId,
      reservation.chunkCount,
    );
    if (
      inspected.encryptedSize !== request.encryptedSize ||
      inspected.encryptedHash !== request.encryptedHash
    ) {
      conflict(
        "Uploaded encrypted bytes do not match the reserved size and SHA-256 hash.",
      );
    }
    await this.encryptedAssets.sealToNotebook(
      request.fileId,
      request.notebookId,
    );

    const completedAt = this.now().toISOString();
    for (
      let attempt = 0;
      attempt < LIMITS.assetTransactionRetries;
      attempt += 1
    ) {
      const transactionId = await this.data.createTransaction(30);
      try {
      const current = await this.data.getRow(
        RESOURCE_IDS.assets,
        request.assetId,
        transactionId,
      );
      if (current === null)
        throw new ApiError(
          404,
          "not_found",
          "Asset reservation was not found.",
        );
      const currentReservation = this.storedReservation(current);
      if (currentReservation.status === "complete") {
        await this.rollbackQuietly(transactionId);
        return { reservation: currentReservation, duplicate: true };
      }
      if (!sameAssetReservation(currentReservation, request))
        conflict("Asset completion does not match its reservation.");
      if (currentReservation.status !== "uploading")
        conflict("Asset reservation is not owned by completion.");
      await this.data.updateRow(
        RESOURCE_IDS.assets,
        request.assetId,
        { status: "complete", completedAt, leaseExpiresAt: null },
        undefined,
        transactionId,
      );
      await this.decrementAssetQuotas(transactionId, currentReservation);
      await this.data.commitTransaction(transactionId);
      break;
      } catch (error) {
        await this.rollbackQuietly(transactionId);
        const reconciled = await this.data.getRow(
        RESOURCE_IDS.assets,
        request.assetId,
      );
        if (
          reconciled !== null &&
          this.storedReservation(reconciled).status === "complete"
        ) {
          const completedReservation = this.storedReservation(reconciled);
          await this.encryptedAssets.removeStagedChunks(
            completedReservation.assetId,
            completedReservation.chunkCount,
          );
          return {
          reservation: completedReservation,
          duplicate: true,
        };
        }
        if (
          !isCode(error, 409) ||
          error instanceof ApiError ||
          attempt === LIMITS.assetTransactionRetries - 1
        )
          throw error;
        await this.retryDelay(attempt);
      }
    }
    await this.encryptedAssets.removeStagedChunks(
      request.assetId,
      reservation.chunkCount,
    );
    const completed = await this.data.getRow(
      RESOURCE_IDS.assets,
      request.assetId,
    );
    if (completed === null)
      throw new ApiError(
        503,
        "service_unavailable",
        "Completed asset could not be read back.",
      );
    return { reservation: this.storedReservation(completed), duplicate: false };
  }

  private async cleanupExpiredAssetReservations(): Promise<void> {
    const now = this.now();
    const expiredPending = await this.data.listRows(RESOURCE_IDS.assets, {
      equal: { status: "pending" },
      lessThan: { expiresAt: now.toISOString() },
      orderAsc: "expiresAt",
      limit: LIMITS.assetCleanupBatch,
    });
    const remaining = LIMITS.assetCleanupBatch - expiredPending.length;
    const expiredUploading =
      remaining > 0
        ? await this.data.listRows(RESOURCE_IDS.assets, {
            equal: { status: "uploading" },
            lessThan: { leaseExpiresAt: now.toISOString() },
            orderAsc: "leaseExpiresAt",
            limit: remaining,
          })
        : [];
    const cleaningRemaining = remaining - expiredUploading.length;
    const expiredCleaning =
      cleaningRemaining > 0
        ? await this.data.listRows(RESOURCE_IDS.assets, {
            equal: { status: "cleaning" },
            lessThan: { leaseExpiresAt: now.toISOString() },
            orderAsc: "leaseExpiresAt",
            limit: cleaningRemaining,
          })
        : [];
    for (const candidate of [
      ...expiredPending,
      ...expiredUploading,
      ...expiredCleaning,
    ]) {
      const claimId = await this.data.createTransaction(30);
      let reservation: AssetReservation | null = null;
      try {
        const current = await this.data.getRow(
          RESOURCE_IDS.assets,
          candidate.$id,
          claimId,
        );
        if (current === null) {
          await this.rollbackQuietly(claimId);
          continue;
        }
        const currentReservation = this.storedReservation(current);
        const expired =
          (currentReservation.status === "pending" &&
            Date.parse(currentReservation.expiresAt) <= now.getTime()) ||
          (currentReservation.status === "uploading" &&
            currentReservation.leaseExpiresAt !== undefined &&
            Date.parse(currentReservation.leaseExpiresAt) <= now.getTime()) ||
          (currentReservation.status === "cleaning" &&
            currentReservation.leaseExpiresAt !== undefined &&
            Date.parse(currentReservation.leaseExpiresAt) <= now.getTime());
        if (!expired) {
          await this.rollbackQuietly(claimId);
          continue;
        }
        await this.data.updateRow(
          RESOURCE_IDS.assets,
          candidate.$id,
          {
            status: "cleaning",
            leaseExpiresAt: new Date(
              now.getTime() + LIMITS.assetLeaseSeconds * 1000,
            ).toISOString(),
          },
          undefined,
          claimId,
        );
        await this.data.commitTransaction(claimId);
        reservation = currentReservation;
      } catch (error) {
        await this.rollbackQuietly(claimId);
        if (!isCode(error, 409)) throw error;
      }
      if (reservation === null) continue;
      await this.encryptedAssets.removeIfExists(reservation.fileId);
      await this.encryptedAssets.removeStagedChunks(
        reservation.assetId,
        reservation.chunkCount,
      );
      const deleteId = await this.data.createTransaction(30);
      try {
        const current = await this.data.getRow(
          RESOURCE_IDS.assets,
          reservation.assetId,
          deleteId,
        );
        if (current === null) {
          await this.rollbackQuietly(deleteId);
          continue;
        }
        const claimed = this.storedReservation(current);
        if (claimed.status !== "cleaning") {
          await this.rollbackQuietly(deleteId);
          continue;
        }
        await this.decrementAssetQuotas(deleteId, claimed);
        await this.data.deleteRow(
          RESOURCE_IDS.assets,
          reservation.assetId,
          deleteId,
        );
        await this.data.commitTransaction(deleteId);
      } catch (error) {
        await this.rollbackQuietly(deleteId);
        if (!isCode(error, 409)) throw error;
      }
    }
  }
}
