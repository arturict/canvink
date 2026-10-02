import {
  Account,
  AppwriteException,
  Channel,
  Client,
  ExecutionMethod,
  Functions,
  ID,
  OAuthProvider,
  Permission,
  Query,
  Realtime,
  Role,
  Storage,
  Teams,
  type Models,
} from "appwrite";
import {
  createAssetUploadAuthorization,
  type DeviceSecretIdentity,
  type EncryptedAssetEnvelope,
} from "../crypto";
import type {
  HeadsAcknowledgement,
  NotebookKeyEnvelope,
  PendingSyncEnvelope,
} from "../types";
import { SyncClientError, toSyncClientError } from "./errors";
import type {
  AssetReservation,
  EmailOtpChallenge,
  EnabledSyncConfiguration,
  NotebookPresence,
  NotebookRole,
  SyncAccount,
  SyncAuthPort,
  SyncDeviceDirectoryPort,
  SyncRealtimePort,
  SyncTeamAdminPort,
  SyncTeamMember,
  SyncTransportPort,
} from "./types";
import {
  catchUpPageFromJson,
  deviceApprovalChallengeFromJson,
  encodeBase64Url,
  encryptedHash,
  headsToJson,
  keyEnvelopeToJson,
  MAX_ENCRYPTED_ASSET_WIRE_BYTES,
  packEncryptedAsset,
  pendingChangeToJson,
  registeredDeviceFromJson,
  decodeBase64Url,
  responseObject,
  syncEnvelopeFromJson,
  storedKeyEnvelopeFromJson,
  unpackEncryptedAsset,
} from "./wire";

const ROLE_SET = new Set<NotebookRole>(["owner", "editor", "viewer"]);
export const ASSET_UPLOAD_CHUNK_BYTES = 3 * 1024 * 1024;
export const FUNCTION_REQUEST_BYTES = 6 * 1024 * 1024;

export interface AppwriteSyncServices {
  auth: SyncAuthPort;
  teamAdmin: SyncTeamAdminPort;
  directory: SyncDeviceDirectoryPort;
  transport: SyncTransportPort;
  realtime: SyncRealtimePort;
}

export function createAppwriteSyncServices(
  config: EnabledSyncConfiguration,
): AppwriteSyncServices {
  const client = new Client()
    .setEndpoint(config.endpoint)
    .setProject(config.projectId);
  const account = new Account(client);
  const teams = new Teams(client);
  const functions = new Functions(client);
  const storage = new Storage(client);
  const realtime = new Realtime(client);
  const transport = new AppwriteFunctionTransport(config, functions, storage);
  return {
    auth: new AppwriteAuthAdapter(account, teams),
    teamAdmin: new AppwriteTeamAdminAdapter(teams),
    directory: transport,
    transport,
    realtime: new AppwriteRealtimeAdapter(config, realtime),
  };
}

interface AccountSdk {
  createOAuth2Session(params: {
    provider: OAuthProvider;
    success?: string;
    failure?: string;
    scopes?: string[];
  }): void | string;
  createEmailToken(params: {
    userId: string;
    email: string;
    phrase?: boolean;
  }): Promise<Models.Token>;
  createSession(params: {
    userId: string;
    secret: string;
  }): Promise<Models.Session>;
  get(): Promise<Models.User<Models.Preferences>>;
  deleteSession(params: { sessionId: string }): Promise<object>;
}

interface TeamsSdk {
  create(params: {
    teamId: string;
    name: string;
    roles?: string[];
  }): Promise<unknown>;
  listMemberships(params: {
    teamId: string;
    queries?: string[];
    total?: boolean;
  }): Promise<Models.MembershipList>;
  createMembership(params: {
    teamId: string;
    roles: string[];
    email?: string;
    url?: string;
  }): Promise<Models.Membership>;
  updateMembership(params: {
    teamId: string;
    membershipId: string;
    roles: string[];
  }): Promise<Models.Membership>;
  deleteMembership(params: {
    teamId: string;
    membershipId: string;
  }): Promise<object>;
}

export class AppwriteAuthAdapter implements SyncAuthPort {
  constructor(
    private readonly account: AccountSdk,
    private readonly teams: TeamsSdk,
  ) {}

  async startMicrosoftOAuth(input: {
    success: string;
    failure: string;
    open?: (url: string) => void;
  }): Promise<void> {
    try {
      const redirect = this.account.createOAuth2Session({
        provider: OAuthProvider.Microsoft,
        success: checkedRedirect(input.success),
        failure: checkedRedirect(input.failure),
      });
      if (typeof redirect === "string") {
        if (!input.open)
          throw new SyncClientError(
            "invalid-config",
            "This shell requires an OAuth URL opener.",
          );
        input.open(redirect);
      }
    } catch (error) {
      throw toSyncClientError(error);
    }
  }

  async startEmailOtp(email: string): Promise<EmailOtpChallenge> {
    const normalized = email.trim().toLowerCase();
    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ||
      normalized.length > 320
    ) {
      throw new SyncClientError(
        "protocol-error",
        "Enter a valid email address.",
      );
    }
    try {
      const token = await this.account.createEmailToken({
        userId: ID.unique(),
        email: normalized,
        phrase: true,
      });
      return {
        userId: token.userId,
        expire: token.expire,
        ...(token.phrase ? { phrase: token.phrase } : {}),
      };
    } catch (error) {
      throw toSyncClientError(error);
    }
  }

  async completeEmailOtp(userId: string, secret: string): Promise<SyncAccount> {
    if (!userId || !secret.trim())
      throw new SyncClientError(
        "protocol-error",
        "The email code is incomplete.",
      );
    try {
      await this.account.createSession({ userId, secret: secret.trim() });
      const account = await this.account.get();
      return accountModel(account);
    } catch (error) {
      throw toSyncClientError(error);
    }
  }

  async currentAccount(): Promise<SyncAccount | null> {
    try {
      return accountModel(await this.account.get());
    } catch (error) {
      if (error instanceof AppwriteException && error.code === 401) return null;
      throw toSyncClientError(error);
    }
  }

  async logout(): Promise<void> {
    try {
      await this.account.deleteSession({ sessionId: "current" });
    } catch (error) {
      throw toSyncClientError(error);
    }
  }

  async roleForNotebook(
    notebookId: string,
    userId: string,
  ): Promise<NotebookRole | null> {
    try {
      const result = await this.teams.listMemberships({
        teamId: notebookId,
        queries: [Query.equal("userId", userId), Query.limit(2)],
        total: false,
      });
      const memberships = result.memberships.filter(
        (membership) => membership.userId === userId && membership.confirm,
      );
      if (memberships.length === 0) return null;
      if (memberships.length !== 1)
        throw new SyncClientError(
          "forbidden",
          "Notebook membership is ambiguous.",
        );
      const roles = memberships[0].roles.filter((role): role is NotebookRole =>
        ROLE_SET.has(role as NotebookRole),
      );
      if (roles.length !== 1 || memberships[0].roles.length !== 1) {
        throw new SyncClientError(
          "forbidden",
          "Notebook membership role is invalid.",
        );
      }
      return roles[0];
    } catch (error) {
      if (error instanceof AppwriteException && error.code === 404) return null;
      throw toSyncClientError(error);
    }
  }
}

export class AppwriteTeamAdminAdapter implements SyncTeamAdminPort {
  constructor(private readonly teams: TeamsSdk) {}

  async enableNotebookTeam(
    notebookId: string,
    displayName: string,
  ): Promise<void> {
    const name = displayName.trim();
    if (!name || name.length > 128)
      throw new SyncClientError(
        "protocol-error",
        "Notebook team name is invalid.",
      );
    try {
      await this.teams.create({ teamId: notebookId, name, roles: ["owner"] });
    } catch (error) {
      if (errorCode(error) !== 409) throw toSyncClientError(error);
    }
  }

  async listMembers(notebookId: string): Promise<readonly SyncTeamMember[]> {
    try {
      const result = await this.teams.listMemberships({
        teamId: notebookId,
        queries: [Query.limit(100)],
        total: false,
      });
      return result.memberships.map(teamMember);
    } catch (error) {
      throw toSyncClientError(error);
    }
  }

  async inviteMember(input: {
    notebookId: string;
    email: string;
    role: NotebookRole;
    redirectUrl: string;
  }): Promise<SyncTeamMember> {
    const email = input.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new SyncClientError(
        "protocol-error",
        "Invitation email is invalid.",
      );
    try {
      return teamMember(
        await this.teams.createMembership({
          teamId: input.notebookId,
          roles: [checkedRole(input.role)],
          email,
          url: checkedRedirect(input.redirectUrl),
        }),
      );
    } catch (error) {
      throw toSyncClientError(error);
    }
  }

  async updateMemberRole(
    notebookId: string,
    membershipId: string,
    role: NotebookRole,
  ): Promise<SyncTeamMember> {
    try {
      return teamMember(
        await this.teams.updateMembership({
          teamId: notebookId,
          membershipId,
          roles: [checkedRole(role)],
        }),
      );
    } catch (error) {
      throw toSyncClientError(error);
    }
  }

  async removeMember(notebookId: string, membershipId: string): Promise<void> {
    try {
      await this.teams.deleteMembership({ teamId: notebookId, membershipId });
    } catch (error) {
      throw toSyncClientError(error);
    }
  }
}

interface FunctionsSdk {
  createExecution(params: {
    functionId: string;
    body?: string;
    async?: boolean;
    xpath?: string;
    method?: ExecutionMethod;
    headers?: object;
  }): Promise<Pick<Models.Execution, "responseStatusCode" | "responseBody">>;
}

interface StorageSdk {
  getFileDownload(params: { bucketId: string; fileId: string }): string;
}

export class AppwriteFunctionTransport
  implements SyncTransportPort, SyncDeviceDirectoryPort
{
  private assetUploadIdentity?: DeviceSecretIdentity;
  constructor(
    private readonly config: EnabledSyncConfiguration,
    private readonly functions: FunctionsSdk,
    private readonly storage: StorageSdk,
    private readonly fetchBytes: (
      url: string,
      signal?: AbortSignal,
    ) => Promise<Uint8Array> = downloadBytes,
  ) {}

  setAssetUploadIdentity(identity: DeviceSecretIdentity): void {
    this.assetUploadIdentity = identity;
  }

  async appendChange(envelope: PendingSyncEnvelope, signal?: AbortSignal) {
    const response = responseObject(
      await this.execute(
        "/appendChange",
        pendingChangeToJson(envelope),
        signal,
      ),
      "append response",
    );
    return {
      envelope: syncEnvelopeFromJson(response.envelope),
      duplicate: response.duplicate === true,
    };
  }

  async listChangesAfter(
    notebookId: string,
    afterSequence: number,
    limit: number,
    signal?: AbortSignal,
  ) {
    return catchUpPageFromJson(
      await this.execute(
        "/listChangesAfter",
        { notebookId, afterSequence, limit },
        signal,
      ),
    );
  }

  async acknowledgeHeads(value: HeadsAcknowledgement, signal?: AbortSignal) {
    const response = responseObject(
      await this.execute("/ackHeads", headsToJson(value), signal),
      "acknowledgement response",
    );
    if (
      !Number.isSafeInteger(response.accepted) ||
      !Number.isSafeInteger(response.sequence)
    ) {
      throw new SyncClientError(
        "protocol-error",
        "Acknowledgement response is invalid.",
      );
    }
    return {
      accepted: response.accepted as number,
      sequence: response.sequence as number,
    };
  }

  async putKeyEnvelope(value: NotebookKeyEnvelope, signal?: AbortSignal) {
    const response = responseObject(
      await this.execute(
        "/putKeyEnvelope",
        await keyEnvelopeToJson(value),
        signal,
      ),
      "key response",
    );
    if (typeof response.envelopeId !== "string")
      throw new SyncClientError("protocol-error", "Key response is invalid.");
    return {
      envelopeId: response.envelopeId,
      duplicate: response.duplicate === true,
    };
  }

  async registerDevice(
    identity: Parameters<SyncDeviceDirectoryPort["registerDevice"]>[0],
  ) {
    const response = responseObject(
      await this.execute("/registerDevice", {
        protocolVersion: identity.protocolVersion,
        deviceId: identity.deviceId,
        encryptionPublicKey: encodeBase64Url(identity.encryptionPublicKey),
        signingPublicKey: encodeBase64Url(identity.signingPublicKey),
      }),
      "device registration",
    );
    return {
      device: registeredDeviceFromJson(response.device),
      duplicate: response.duplicate === true,
      bootstrap: response.bootstrap === true,
    };
  }

  async listMyDevices(input: { cursor?: string; limit?: number } = {}) {
    const response = responseObject(
      await this.execute("/listMyDevices", input),
      "device directory",
    );
    if (!Array.isArray(response.devices))
      throw new SyncClientError(
        "protocol-error",
        "Device directory is invalid.",
      );
    const nextCursor = optionalCursor(response.nextCursor);
    return {
      devices: response.devices.map(registeredDeviceFromJson),
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  async listNotebookDevices(input: {
    notebookId: string;
    cursor?: string;
    limit?: number;
  }) {
    const response = responseObject(
      await this.execute("/listNotebookDevices", input),
      "notebook device directory",
    );
    if (!Array.isArray(response.devices))
      throw new SyncClientError(
        "protocol-error",
        "Notebook device directory is invalid.",
      );
    const devices = response.devices.map(registeredDeviceFromJson);
    if (devices.some((device) => device.status !== "active"))
      throw new SyncClientError(
        "protocol-error",
        "Notebook device directory exposed an inactive device.",
      );
    const nextCursor = optionalCursor(response.nextCursor);
    return { devices, ...(nextCursor ? { nextCursor } : {}) };
  }

  async revokeDevice(input: { deviceId: string; notebookId?: string }) {
    const response = responseObject(
      await this.execute("/revokeDevice", input),
      "device revocation",
    );
    return {
      device: registeredDeviceFromJson(response.device),
      duplicate: response.duplicate === true,
    };
  }

  async createDeviceApprovalChallenge(input: {
    notebookId: string;
    requestingDeviceId: string;
  }) {
    const response = responseObject(
      await this.execute("/createDeviceApprovalChallenge", {
        protocolVersion: 1,
        ...input,
      }),
      "device approval challenge",
    );
    if (
      typeof response.challengeId !== "string" ||
      response.challengeId.length < 1 ||
      response.challengeId.length > 256
    ) {
      throw new SyncClientError(
        "protocol-error",
        "Device approval challenge ID is invalid.",
      );
    }
    return {
      challengeId: response.challengeId,
      challenge: deviceApprovalChallengeFromJson(response.challenge),
    };
  }

  async activateDevice(
    input: Parameters<SyncDeviceDirectoryPort["activateDevice"]>[0],
  ) {
    const response = responseObject(
      await this.execute("/activateDevice", {
        challengeId: input.challengeId,
        proof: {
          protocolVersion: input.proof.protocolVersion,
          approverDeviceId: input.proof.approverDeviceId,
          challengeHash: encodeBase64Url(input.proof.challengeHash),
          signature: encodeBase64Url(input.proof.signature),
        },
      }),
      "device activation",
    );
    return {
      device: registeredDeviceFromJson(response.device),
      duplicate: response.duplicate === true,
    };
  }

  async activateDeviceWithRecovery(
    input: Parameters<SyncDeviceDirectoryPort["activateDeviceWithRecovery"]>[0],
  ) {
    const response = responseObject(
      await this.execute("/activateDeviceWithRecovery", {
        challengeId: input.challengeId,
        proof: {
          protocolVersion: input.proof.protocolVersion,
          recoveryKeyId: input.proof.recoveryKeyId,
          challengeHash: encodeBase64Url(input.proof.challengeHash),
          signature: encodeBase64Url(input.proof.signature),
        },
      }),
      "recovery device activation",
    );
    return {
      device: registeredDeviceFromJson(response.device),
      duplicate: response.duplicate === true,
    };
  }

  async listKeyEnvelopes(input: {
    notebookId: string;
    recipient: { kind: "account" | "device" | "recovery"; id: string };
    cursor?: string;
    limit?: number;
  }) {
    const response = responseObject(
      await this.execute("/listKeyEnvelopes", input),
      "key envelope directory",
    );
    if (!Array.isArray(response.envelopes))
      throw new SyncClientError(
        "protocol-error",
        "Key envelope directory is invalid.",
      );
    const nextCursor = optionalCursor(response.nextCursor);
    return {
      envelopes: response.envelopes.map(storedKeyEnvelopeFromJson),
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  async uploadEncryptedAsset(
    value: EncryptedAssetEnvelope,
    signal?: AbortSignal,
  ): Promise<AssetReservation> {
    const bytes = packEncryptedAsset(value);
    const hash = await encryptedHash(bytes);
    const identity = this.assetUploadIdentity;
    if (
      !identity ||
      identity.publicIdentity.deviceId !== value.uploaderDeviceId
    ) {
      throw new SyncClientError(
        "forbidden",
        "The active device signing identity is required for encrypted asset upload.",
      );
    }
    const uploadSignature = encodeBase64Url(
      await createAssetUploadAuthorization({
        notebookId: value.notebookId,
        deviceId: value.uploaderDeviceId,
        encryptedHash: decodeBase64Url(hash, "encrypted asset hash"),
        encryptedSize: bytes.byteLength,
        signer: identity,
      }),
    );
    const request = {
      protocolVersion: 1 as const,
      notebookId: value.notebookId,
      deviceId: value.uploaderDeviceId,
      encryptedHash: hash,
      encryptedSize: bytes.byteLength,
      uploadSignature,
    };
    const begun = responseObject(
      await this.execute("/beginAssetUpload", request, signal),
      "asset reservation",
    );
    const reservation = parseReservation(begun.reservation);
    assertReservationMatches(reservation, request, this.config.assetBucketId);
    if (reservation.status === "pending") {
      abortIfNeeded(signal);
      const chunkCount = Math.ceil(bytes.byteLength / ASSET_UPLOAD_CHUNK_BYTES);
      if (reservation.chunkCount !== chunkCount) {
        throw new SyncClientError(
          "protocol-error",
          "Asset reservation chunk budget is invalid.",
        );
      }
      for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
        abortIfNeeded(signal);
        const chunk = bytes.slice(
          chunkIndex * ASSET_UPLOAD_CHUNK_BYTES,
          Math.min((chunkIndex + 1) * ASSET_UPLOAD_CHUNK_BYTES, bytes.byteLength),
        );
        const response = responseObject(
          await this.execute(
            "/uploadAssetChunk",
            {
              ...request,
              assetId: reservation.assetId,
              fileId: reservation.fileId,
              chunkIndex,
              chunkCount,
              chunkHash: await encryptedHash(chunk),
              chunkBytes: encodeBase64Url(chunk),
            },
            signal,
          ),
          "asset chunk response",
        );
        if (response.acceptedBytes !== chunk.byteLength) {
          throw new SyncClientError(
            "protocol-error",
            "Encrypted asset chunk was not accepted exactly.",
          );
        }
      }
      abortIfNeeded(signal);
    }
    const completed = responseObject(
      await this.execute(
        "/completeAssetUpload",
        {
          ...request,
          assetId: reservation.assetId,
          fileId: reservation.fileId,
        },
        signal,
      ),
      "asset completion",
    );
    const completedReservation = parseReservation(completed.reservation);
    assertReservationMatches(
      completedReservation,
      request,
      this.config.assetBucketId,
    );
    if (completedReservation.status !== "complete")
      throw new SyncClientError(
        "protocol-error",
        "Asset completion was not confirmed.",
      );
    return completedReservation;
  }

  async downloadEncryptedAsset(input: {
    reservation: Pick<AssetReservation, "bucketId" | "fileId">;
    metadata: Omit<
      EncryptedAssetEnvelope,
      "nonce" | "ciphertext" | "signature"
    >;
    signal?: AbortSignal;
  }): Promise<EncryptedAssetEnvelope> {
    if (input.reservation.bucketId !== this.config.assetBucketId) {
      throw new SyncClientError(
        "protocol-error",
        "Encrypted asset bucket is invalid.",
      );
    }
    const url = this.storage.getFileDownload(input.reservation);
    return unpackEncryptedAsset(
      await this.fetchBytes(url, input.signal),
      input.metadata,
    );
  }

  private async execute(
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    abortIfNeeded(signal);
    try {
      const serialized = JSON.stringify(body);
      if (new TextEncoder().encode(serialized).byteLength > FUNCTION_REQUEST_BYTES) {
        throw new SyncClientError(
          "protocol-error",
          "Sync request exceeds the Function request boundary.",
        );
      }
      const execution = await this.functions.createExecution({
        functionId: this.config.functionId,
        body: serialized,
        async: false,
        xpath: path,
        method: ExecutionMethod.POST,
        headers: { "content-type": "application/json" },
      });
      abortIfNeeded(signal);
      let response: unknown;
      try {
        response = JSON.parse(execution.responseBody) as unknown;
      } catch (error) {
        throw new SyncClientError(
          "protocol-error",
          "Sync returned invalid JSON.",
          { cause: error },
        );
      }
      if (
        execution.responseStatusCode < 200 ||
        execution.responseStatusCode >= 300
      ) {
        throw responseError(execution.responseStatusCode, response);
      }
      return response;
    } catch (error) {
      throw toSyncClientError(error);
    }
  }
}

interface RealtimeSdk {
  subscribe(
    channels: unknown[],
    callback: (event: { payload: unknown }) => void,
  ): Promise<{ unsubscribe(): Promise<void> }>;
  upsertPresence(params: {
    status: string;
    presenceId: string;
    permissions?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<void>;
  disconnect(): Promise<void>;
}

export class AppwriteRealtimeAdapter implements SyncRealtimePort {
  constructor(
    private readonly config: EnabledSyncConfiguration,
    private readonly realtime: RealtimeSdk,
  ) {}

  async subscribe(input: {
    notebookId: string;
    onWake: () => void;
    onPresence: (presence: NotebookPresence) => void;
  }) {
    const subscription = await this.realtime.subscribe(
      [
        Channel.tablesdb(this.config.databaseId)
          .table(this.config.changesTableId)
          .row(),
        Channel.team(input.notebookId),
        Channel.presences(),
      ],
      (event) => {
        const presence = parsePresence(event.payload, input.notebookId);
        if (presence) input.onPresence(presence);
        else input.onWake();
      },
    );
    return () => subscription.unsubscribe();
  }

  async publishPresence(presence: NotebookPresence): Promise<void> {
    const value = validatePresence(presence);
    const identity = new TextEncoder().encode(
      `${value.notebookId}\0${value.deviceId}`,
    );
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", identity),
    );
    await this.realtime.upsertPresence({
      status: "online",
      presenceId: `p_${Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
      permissions: [Permission.read(Role.team(value.notebookId))],
      metadata: { ...value },
    });
  }

  disconnect(): Promise<void> {
    return this.realtime.disconnect();
  }
}

function checkedRedirect(value: string): string {
  const url = new URL(value);
  const localHttp =
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (!["https:", "tauri:"].includes(url.protocol) && !localHttp) ||
    url.username ||
    url.password
  ) {
    throw new SyncClientError(
      "invalid-config",
      "OAuth redirect URL is invalid.",
    );
  }
  return url.toString();
}

function errorCode(error: unknown): number {
  return typeof error === "object" && error !== null && "code" in error
    ? Number(error.code)
    : 0;
}

function accountModel(value: Models.User<Models.Preferences>): SyncAccount {
  const email =
    "email" in value && typeof value.email === "string"
      ? value.email
      : undefined;
  return { userId: value.$id, name: value.name, ...(email ? { email } : {}) };
}

function checkedRole(value: NotebookRole): NotebookRole {
  if (!ROLE_SET.has(value))
    throw new SyncClientError("protocol-error", "Notebook role is invalid.");
  return value;
}

function teamMember(value: Models.Membership): SyncTeamMember {
  const roles = value.roles.filter((role): role is NotebookRole =>
    ROLE_SET.has(role as NotebookRole),
  );
  if (roles.length !== 1 || value.roles.length !== 1)
    throw new SyncClientError(
      "protocol-error",
      "Notebook membership role is invalid.",
    );
  return {
    membershipId: value.$id,
    userId: value.userId,
    name: value.userName,
    email: value.userEmail,
    role: roles[0],
    confirmed: value.confirm,
  };
}

function responseError(
  status: number,
  value: unknown,
): Error & { code: number } {
  const error = new Error("Sync request failed.") as Error & { code: number };
  error.code = status;
  void value;
  return error;
}

function parseReservation(value: unknown): AssetReservation {
  const reservation = responseObject(value, "asset reservation");
  const strings = [
    "notebookId",
    "deviceId",
    "encryptedHash",
    "uploadSignature",
    "assetId",
    "fileId",
    "bucketId",
    "expiresAt",
  ] as const;
  if (
    strings.some((key) => typeof reservation[key] !== "string") ||
    reservation.protocolVersion !== 1 ||
    !Number.isSafeInteger(reservation.encryptedSize) ||
    !Number.isSafeInteger(reservation.chunkCount)
  ) {
    throw new SyncClientError(
      "protocol-error",
      "Asset reservation is invalid.",
    );
  }
  if (
    reservation.status !== "pending" &&
    reservation.status !== "uploading" &&
    reservation.status !== "cleaning" &&
    reservation.status !== "complete"
  ) {
    throw new SyncClientError(
      "protocol-error",
      "Asset reservation status is invalid.",
    );
  }
  return reservation as unknown as AssetReservation;
}

function assertReservationMatches(
  reservation: AssetReservation,
  request: {
    protocolVersion: 1;
    notebookId: string;
    deviceId: string;
    encryptedHash: string;
    encryptedSize: number;
    uploadSignature: string;
  },
  bucketId: string,
): void {
  if (
    reservation.protocolVersion !== request.protocolVersion ||
    reservation.notebookId !== request.notebookId ||
    reservation.deviceId !== request.deviceId ||
    reservation.encryptedHash !== request.encryptedHash ||
    reservation.encryptedSize !== request.encryptedSize ||
    reservation.uploadSignature !== request.uploadSignature ||
    reservation.chunkCount !==
      Math.ceil(request.encryptedSize / ASSET_UPLOAD_CHUNK_BYTES) ||
    reservation.bucketId !== bucketId
  )
    throw new SyncClientError(
      "protocol-error",
      "Asset reservation does not match the encrypted upload.",
    );
}

function validatePresence(value: NotebookPresence): NotebookPresence {
  if (
    !value.notebookId ||
    !value.deviceId ||
    !value.pageId ||
    value.name.trim().length < 1 ||
    value.name.length > 80 ||
    !/^#[0-9a-f]{6}$/i.test(value.color)
  )
    throw new SyncClientError(
      "protocol-error",
      "Presence metadata is invalid.",
    );
  if (
    value.cursor &&
    ![value.cursor.x, value.cursor.y].every(Number.isFinite)
  ) {
    throw new SyncClientError("protocol-error", "Presence cursor is invalid.");
  }
  if (
    value.selection &&
    ![value.selection.anchor, value.selection.head].every(Number.isSafeInteger)
  ) {
    throw new SyncClientError(
      "protocol-error",
      "Presence selection is invalid.",
    );
  }
  return structuredClone(value);
}

function parsePresence(
  payload: unknown,
  notebookId: string,
): NotebookPresence | null {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("metadata" in payload)
  )
    return null;
  const metadata = (payload as { metadata?: unknown }).metadata;
  if (
    typeof metadata !== "object" ||
    metadata === null ||
    (metadata as { notebookId?: unknown }).notebookId !== notebookId
  )
    return null;
  try {
    return validatePresence(metadata as NotebookPresence);
  } catch {
    return null;
  }
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

function optionalCursor(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length < 1 || value.length > 512)
    throw new SyncClientError("protocol-error", "Directory cursor is invalid.");
  return value;
}

async function downloadBytes(
  url: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const response = await fetch(url, {
    signal,
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok)
    throw Object.assign(new Error("Asset download failed."), {
      code: response.status,
    });
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_ENCRYPTED_ASSET_WIRE_BYTES) {
    throw new SyncClientError(
      "protocol-error",
      "Encrypted asset download exceeds its limit.",
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_ENCRYPTED_ASSET_WIRE_BYTES) {
    throw new SyncClientError(
      "protocol-error",
      "Encrypted asset download exceeds its limit.",
    );
  }
  return bytes;
}
