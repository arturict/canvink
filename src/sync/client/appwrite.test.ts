import { ExecutionMethod, OAuthProvider } from "appwrite";
import { describe, expect, it, vi } from "vitest";
import {
  createDeviceIdentity,
  encryptAsset,
  generateNotebookKey,
  verifyAndDecryptAsset,
} from "../crypto";
import {
  SYNC_PROTOCOL_VERSION,
  type NotebookKeyEnvelope,
  type PendingSyncEnvelope,
} from "../types";
import {
  AppwriteAuthAdapter,
  AppwriteFunctionTransport,
  AppwriteRealtimeAdapter,
  ASSET_UPLOAD_CHUNK_BYTES,
  FUNCTION_REQUEST_BYTES,
} from "./appwrite";
import {
  createOptionalSyncClient,
  validateSyncConfiguration,
} from "./configuration";
import type { EnabledSyncConfiguration, NotebookPresence } from "./types";
import { decodeBase64Url, encodeBase64Url } from "./wire";

const CONFIG: EnabledSyncConfiguration = {
  enabled: true,
  endpoint: "https://cloud.example/v1",
  projectId: "project",
  functionId: "canvink-sync",
  databaseId: "canvink-sync",
  changesTableId: "sync_changes",
  assetBucketId: "canvink-encrypted-assets",
};

function bytes(length: number, fill: number): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

function pending(): PendingSyncEnvelope {
  return {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    notebookId: "notebook",
    documentId: "document",
    deviceId: "device",
    keyEpoch: 3,
    sequence: null,
    changeHash: bytes(32, 1),
    nonce: bytes(24, 2),
    ciphertext: bytes(10, 3),
    signature: bytes(64, 4),
  };
}

describe("Appwrite client adapters", () => {
  it("keeps base64 chunk requests below 6 MiB and budgets 22 chunks for 64 MiB", () => {
    const maximumChunk = new Uint8Array(ASSET_UPLOAD_CHUNK_BYTES);
    const encodedRequestBytes = new TextEncoder().encode(
      JSON.stringify({
        protocolVersion: 1,
        notebookId: "n".repeat(36),
        deviceId: "d".repeat(128),
        assetId: "a".repeat(36),
        fileId: "f".repeat(36),
        encryptedHash: "h".repeat(43),
        encryptedSize: 64 * 1024 * 1024,
        uploadSignature: "s".repeat(86),
        chunkIndex: 21,
        chunkCount: 22,
        chunkHash: "c".repeat(43),
        chunkBytes: encodeBase64Url(maximumChunk),
      }),
    ).byteLength;
    expect(encodedRequestBytes).toBeLessThan(FUNCTION_REQUEST_BYTES);
    expect(Math.ceil((64 * 1024 * 1024) / ASSET_UPLOAD_CHUNK_BYTES)).toBe(22);
    expect(22 * ASSET_UPLOAD_CHUNK_BYTES).toBeGreaterThanOrEqual(
      64 * 1024 * 1024,
    );
  });
  it("keeps accountless local mode free of Appwrite construction or calls", () => {
    const factory = vi.fn(() => ({ remote: true }));
    expect(createOptionalSyncClient(undefined, factory)).toBeNull();
    expect(createOptionalSyncClient({ enabled: false }, factory)).toBeNull();
    expect(factory).not.toHaveBeenCalled();
    expect(validateSyncConfiguration(CONFIG)).toMatchObject({
      enabled: true,
      projectId: "project",
    });
    expect(() =>
      validateSyncConfiguration({
        ...CONFIG,
        endpoint: "http://remote.example/v1",
      }),
    ).toThrow(/HTTPS/);
  });

  it("uses object-parameter Microsoft OAuth, email OTP, session, and exact one-role membership APIs", async () => {
    const calls: unknown[] = [];
    const account = {
      createOAuth2Session: (params: unknown) => {
        calls.push(params);
        return "tauri://oauth";
      },
      createEmailToken: async (params: unknown) => {
        calls.push(params);
        return {
          userId: "user",
          expire: "2026-08-03T13:00:00.000Z",
          phrase: "blue fox",
        };
      },
      createSession: async (params: unknown) => {
        calls.push(params);
        return {};
      },
      get: async () => ({
        $id: "user",
        name: "Ada",
        email: "ada@example.test",
      }),
      deleteSession: async (params: unknown) => {
        calls.push(params);
        return {};
      },
    };
    const teams = {
      listMemberships: async (params: unknown) => {
        calls.push(params);
        return {
          total: 1,
          memberships: [{ userId: "user", confirm: true, roles: ["editor"] }],
        };
      },
    };
    const auth = new AppwriteAuthAdapter(account as never, teams as never);
    const open = vi.fn();
    await auth.startMicrosoftOAuth({
      success: "tauri://localhost/success",
      failure: "tauri://localhost/failure",
      open,
    });
    expect(calls[0]).toMatchObject({ provider: OAuthProvider.Microsoft });
    expect(open).toHaveBeenCalledWith("tauri://oauth");
    await expect(auth.startEmailOtp("Ada@Example.Test")).resolves.toMatchObject(
      { userId: "user", phrase: "blue fox" },
    );
    await expect(
      auth.completeEmailOtp("user", "123456"),
    ).resolves.toMatchObject({ userId: "user", name: "Ada" });
    await expect(auth.roleForNotebook("notebook", "user")).resolves.toBe(
      "editor",
    );
    await auth.logout();
    expect(calls).toContainEqual({ sessionId: "current" });
  });

  it("round-trips epochs, recipient public keys, and encrypted assets through exact Function routes", async () => {
    const executions: Array<Record<string, unknown>> = [];
    let uploaded = new Uint8Array();
    let reservedChunkCount = 0;
    const functions = {
      createExecution: async (params: Record<string, unknown>) => {
        executions.push(params);
        const body = JSON.parse(String(params.body)) as Record<string, unknown>;
        let response: unknown;
        if (params.xpath === "/appendChange")
          response = { envelope: { ...body, sequence: 1 }, duplicate: false };
        else if (params.xpath === "/putKeyEnvelope")
          response = { envelopeId: "env", duplicate: false };
        else if (params.xpath === "/beginAssetUpload") {
          reservedChunkCount = Math.ceil(Number(body.encryptedSize) / (3 * 1024 * 1024));
          response = {
            reservation: {
              ...body,
              assetId: "asset",
              fileId: "file",
              bucketId: CONFIG.assetBucketId,
              chunkCount: reservedChunkCount,
              status: "pending",
              expiresAt: "2026-08-03T13:00:00.000Z",
            },
            duplicate: false,
          };
        } else if (params.xpath === "/uploadAssetChunk") {
          uploaded = Uint8Array.from(
            decodeBase64Url(
              String(body.chunkBytes),
              "encrypted asset test chunk",
            ),
          );
          response = {
            acceptedBytes: uploaded.byteLength,
            duplicate: false,
          };
        } else
          response = {
            reservation: {
              ...body,
              bucketId: CONFIG.assetBucketId,
              chunkCount: reservedChunkCount,
              status: "complete",
              expiresAt: "2026-08-03T13:00:00.000Z",
              completedAt: "2026-08-03T12:00:00.000Z",
            },
            duplicate: false,
          };
        return {
          responseStatusCode: 200,
          responseBody: JSON.stringify(response),
        };
      },
    };
    const storage = {
      createFile: vi.fn(async () => {
        throw new Error("Client storage creation must not be used.");
      }),
      getFileDownload: () => "https://cloud.example/download",
    };
    const transport = new AppwriteFunctionTransport(
      CONFIG,
      functions as never,
      storage as never,
      async () => uploaded,
    );
    await expect(transport.appendChange(pending())).resolves.toMatchObject({
      envelope: { keyEpoch: 3, sequence: 1 },
    });
    expect(executions[0]).toMatchObject({
      xpath: "/appendChange",
      method: ExecutionMethod.POST,
      async: false,
    });
    expect(JSON.parse(String(executions[0].body))).toMatchObject({
      keyEpoch: 3,
    });

    const keyEnvelope: NotebookKeyEnvelope = {
      protocolVersion: 1,
      notebookId: "notebook",
      keyEpoch: 4,
      senderDeviceId: "device",
      recipient: { kind: "device", deviceId: "recipient" },
      senderEncryptionPublicKey: bytes(32, 5),
      recipientEncryptionPublicKey: bytes(32, 6),
      nonce: bytes(24, 7),
      ciphertext: bytes(48, 8),
      signature: bytes(64, 9),
    };
    await transport.putKeyEnvelope(keyEnvelope);
    expect(JSON.parse(String(executions[1].body))).toHaveProperty(
      "recipientEncryptionPublicKey",
    );

    const sender = await createDeviceIdentity({
      accountId: "user",
      deviceId: "device",
      encryptionSeed: bytes(32, 10),
      signingSeed: bytes(32, 11),
    });
    transport.setAssetUploadIdentity(sender);
    const notebookKey = await generateNotebookKey("notebook", 4);
    const encrypted = await encryptAsset({
      notebookId: "notebook",
      mimeType: "image/png",
      plaintext: bytes(100, 12),
      notebookKey,
      sender,
      nonce: bytes(24, 13),
    });
    const reservation = await transport.uploadEncryptedAsset(encrypted);
    expect(reservation.status).toBe("complete");
    expect(new TextDecoder().decode(uploaded.slice(0, 8))).toBe("CNVKAST1");
    expect(new TextDecoder().decode(uploaded)).not.toContain("image/png");
    const beginRequest = JSON.parse(String(executions[2].body)) as Record<
      string,
      unknown
    >;
    const chunkRequest = JSON.parse(String(executions[3].body)) as Record<
      string,
      unknown
    >;
    const completeRequest = JSON.parse(String(executions[4].body)) as Record<
      string,
      unknown
    >;
    expect(beginRequest).toMatchObject({
      protocolVersion: 1,
      notebookId: "notebook",
      deviceId: "device",
    });
    expect(beginRequest.uploadSignature).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(chunkRequest.uploadSignature).toBe(beginRequest.uploadSignature);
    expect(completeRequest.uploadSignature).toBe(beginRequest.uploadSignature);
    expect(storage.createFile).not.toHaveBeenCalled();
    expect(JSON.stringify(beginRequest)).not.toMatch(
      /mime|plaintext|filename/i,
    );
    expect(JSON.stringify(chunkRequest)).not.toMatch(
      /mime|plaintext|filename/i,
    );
    const downloaded = await transport.downloadEncryptedAsset({
      reservation,
      metadata: {
        protocolVersion: encrypted.protocolVersion,
        notebookId: encrypted.notebookId,
        assetId: encrypted.assetId,
        mimeType: encrypted.mimeType,
        uploaderDeviceId: encrypted.uploaderDeviceId,
        keyEpoch: encrypted.keyEpoch,
        plaintextSize: encrypted.plaintextSize,
        plaintextHash: encrypted.plaintextHash,
      },
    });
    await expect(
      verifyAndDecryptAsset({
        envelope: downloaded,
        notebookKey,
        sender: sender.publicIdentity,
      }),
    ).resolves.toEqual(bytes(100, 12));
  });

  it("keeps pending device registration fail-closed and uses exact approval/directory routes", async () => {
    const executions: Array<Record<string, unknown>> = [];
    const jsonDevice = {
      protocolVersion: 1,
      deviceId: "pending-device",
      encryptionPublicKey: encodeBase64Url(bytes(32, 1)),
      signingPublicKey: encodeBase64Url(bytes(32, 2)),
      status: "pending",
      createdAt: "2026-08-03T12:00:00.000Z",
      updatedAt: "2026-08-03T12:00:00.000Z",
    };
    const keyEnvelope = {
      envelopeId: "envelope-1",
      envelopeHash: encodeBase64Url(bytes(32, 9)),
      senderSigningPublicKey: encodeBase64Url(bytes(32, 10)),
      protocolVersion: 1,
      notebookId: "notebook",
      keyEpoch: 2,
      senderDeviceId: "active-device",
      recipient: { kind: "device", id: "pending-device" },
      senderEncryptionPublicKey: encodeBase64Url(bytes(32, 3)),
      recipientEncryptionPublicKey: encodeBase64Url(bytes(32, 1)),
      nonce: encodeBase64Url(bytes(24, 4)),
      ciphertext: encodeBase64Url(bytes(48, 5)),
      signature: encodeBase64Url(bytes(64, 6)),
    };
    const functions = {
      createExecution: async (params: Record<string, unknown>) => {
        executions.push(params);
        const body = JSON.parse(String(params.body)) as Record<string, unknown>;
        let response: unknown;
        if (params.xpath === "/registerDevice")
          response = { device: jsonDevice, duplicate: false, bootstrap: false };
        else if (params.xpath === "/listMyDevices")
          response = { devices: [jsonDevice] };
        else if (params.xpath === "/listNotebookDevices")
          response = { devices: [{ ...jsonDevice, status: "active" }] };
        else if (params.xpath === "/createDeviceApprovalChallenge")
          response = {
            challengeId: "challenge-1",
            challenge: {
              ...body,
              accountId: "account",
              requestingEncryptionPublicKey: jsonDevice.encryptionPublicKey,
              requestingSigningPublicKey: jsonDevice.signingPublicKey,
              nonce: encodeBase64Url(bytes(32, 7)),
              issuedAt: 1_000,
              expiresAt: 301_000,
            },
          };
        else if (
          params.xpath === "/activateDevice" ||
          params.xpath === "/activateDeviceWithRecovery"
        )
          response = {
            device: { ...jsonDevice, status: "active" },
            duplicate: false,
          };
        else if (params.xpath === "/listKeyEnvelopes")
          response = { envelopes: [keyEnvelope] };
        else
          response = {
            device: {
              ...jsonDevice,
              status: "revoked",
              revokedAt: "2026-08-03T12:10:00.000Z",
            },
            duplicate: false,
          };
        return {
          responseStatusCode: 200,
          responseBody: JSON.stringify(response),
        };
      },
    };
    const transport = new AppwriteFunctionTransport(
      CONFIG,
      functions as never,
      {} as never,
    );
    await expect(
      transport.registerDevice({
        protocolVersion: 1,
        deviceId: "pending-device",
        encryptionPublicKey: bytes(32, 1),
        signingPublicKey: bytes(32, 2),
      }),
    ).resolves.toMatchObject({
      device: { status: "pending" },
      bootstrap: false,
    });
    await expect(transport.listMyDevices()).resolves.toMatchObject({
      devices: [{ deviceId: "pending-device" }],
    });
    await expect(
      transport.listNotebookDevices({ notebookId: "notebook" }),
    ).resolves.toMatchObject({ devices: [{ status: "active" }] });
    await expect(
      transport.createDeviceApprovalChallenge({
        notebookId: "notebook",
        requestingDeviceId: "pending-device",
      }),
    ).resolves.toMatchObject({
      challengeId: "challenge-1",
      challenge: { accountId: "account" },
    });
    await expect(
      transport.activateDevice({
        challengeId: "challenge-1",
        proof: {
          protocolVersion: 1,
          approverDeviceId: "active-device",
          challengeHash: bytes(32, 8),
          signature: bytes(64, 9),
        },
      }),
    ).resolves.toMatchObject({ device: { status: "active" } });
    await expect(
      transport.activateDeviceWithRecovery({
        challengeId: "challenge-1",
        proof: {
          protocolVersion: 1,
          recoveryKeyId: "recovery:key",
          challengeHash: bytes(32, 8),
          signature: bytes(64, 9),
        },
      }),
    ).resolves.toMatchObject({ device: { status: "active" } });
    await expect(
      transport.listKeyEnvelopes({
        notebookId: "notebook",
        recipient: { kind: "device", id: "pending-device" },
      }),
    ).resolves.toMatchObject({
      envelopes: [{ envelopeId: "envelope-1", envelope: { keyEpoch: 2 } }],
    });
    await expect(
      transport.revokeDevice({
        deviceId: "pending-device",
        notebookId: "notebook",
      }),
    ).resolves.toMatchObject({ device: { status: "revoked" } });
    expect(executions.map((execution) => execution.xpath)).toEqual([
      "/registerDevice",
      "/listMyDevices",
      "/listNotebookDevices",
      "/createDeviceApprovalChallenge",
      "/activateDevice",
      "/activateDeviceWithRecovery",
      "/listKeyEnvelopes",
      "/revokeDevice",
    ]);
  });

  it("publishes only bounded ephemeral presence and treats Realtime events as wakeups", async () => {
    let callback: ((event: { payload: unknown }) => void) | undefined;
    const upsertPresence = vi.fn(
      async (params: { metadata?: Record<string, unknown> }) => {
        void params;
      },
    );
    const realtime = {
      subscribe: async (
        _channels: unknown[],
        listener: (event: { payload: unknown }) => void,
      ) => {
        callback = listener;
        return { unsubscribe: async () => undefined };
      },
      upsertPresence,
      disconnect: vi.fn(async () => undefined),
    };
    const adapter = new AppwriteRealtimeAdapter(CONFIG, realtime);
    const onWake = vi.fn();
    const onPresence = vi.fn();
    await adapter.subscribe({ notebookId: "notebook", onWake, onPresence });
    callback?.({ payload: { $id: "change" } });
    expect(onWake).toHaveBeenCalledOnce();
    const presence: NotebookPresence = {
      notebookId: "notebook",
      deviceId: "device",
      name: "Ada",
      color: "#112233",
      pageId: "page",
      cursor: { x: 1, y: 2 },
    };
    await adapter.publishPresence(presence);
    const firstCall = upsertPresence.mock.calls[0];
    if (!firstCall) throw new Error("Expected a presence upsert.");
    const params = firstCall[0];
    expect(params.metadata).toEqual(presence);
    expect(JSON.stringify(params)).not.toMatch(/content|handwriting|title/i);
  });
});
