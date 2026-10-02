import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { AppwriteSyncRepository } from "../src/appwriteRepository.js";
import type {
  AuthenticatedUser,
  NotebookKeyEnvelope,
} from "../src/contracts.js";
import { ApiError } from "../src/errors.js";
import { SyncService } from "../src/service.js";
import {
  approvalProof,
  assetUploadRequest,
  bytes,
  change,
  deviceRegistration,
  MemoryAssetPort,
  MemoryDataPort,
  MemoryMemberships,
  recoveryApprovalProof,
  resignKeyEnvelope,
  signKeyEnvelope,
  TEST_RECOVERY_SIGNING_PUBLIC_KEY,
} from "./helpers.js";

const user: AuthenticatedUser = { userId: "user-1", jwt: "jwt" };

function setup(role: "owner" | "editor" | "viewer") {
  const memberships = new MemoryMemberships();
  memberships.set("notebook-1", user.userId, role);
  memberships.set("notebook-1", "user-2", "viewer");
  const repository = new AppwriteSyncRepository(
    new MemoryDataPort(),
    new MemoryAssetPort(),
    {
      retryDelay: async () => undefined,
    },
  );
  return { memberships, service: new SyncService(memberships, repository) };
}

function keyEnvelope(): NotebookKeyEnvelope {
  return signKeyEnvelope({
    protocolVersion: 1,
    notebookId: "notebook-1",
    keyEpoch: 1,
    senderDeviceId: "device-1",
    recipient: { kind: "account", id: "user-2" },
    senderEncryptionPublicKey: bytes(32, 21),
    recipientEncryptionPublicKey: bytes(32, 6),
    nonce: bytes(24, 2),
    ciphertext: bytes(32, 3),
    envelopeHash: bytes(32, 5),
  });
}

function recoveryEnvelope(): NotebookKeyEnvelope {
  return signKeyEnvelope({
    protocolVersion: 1,
    notebookId: "notebook-1",
    keyEpoch: 1,
    senderDeviceId: "device-1",
    recipient: { kind: "recovery", id: "recovery-1" },
    senderEncryptionPublicKey: bytes(32, 21),
    recipientEncryptionPublicKey: bytes(32, 22),
    recoverySigningPublicKey: TEST_RECOVERY_SIGNING_PUBLIC_KEY,
    nonce: bytes(24, 23),
    ciphertext: bytes(32, 24),
    envelopeHash: bytes(32, 25),
  });
}

test("owner can write changes and key envelopes", async () => {
  const { service } = setup("owner");
  await service.registerDevice(user, deviceRegistration());
  assert.equal(
    (await service.appendChange(user, change())).envelope.sequence,
    1,
  );
  assert.equal(
    (await service.putKeyEnvelope(user, keyEnvelope())).duplicate,
    false,
  );
});

test("editor can append but cannot manage notebook key envelopes", async () => {
  const { service } = setup("editor");
  await service.registerDevice(user, deviceRegistration());
  await service.appendChange(user, change());
  await assert.rejects(
    service.putKeyEnvelope(user, keyEnvelope()),
    (error: unknown) => error instanceof ApiError && error.status === 403,
  );
});

test("viewer can list and acknowledge but cannot write", async () => {
  const { service } = setup("viewer");
  await service.registerDevice(user, deviceRegistration());
  const page = await service.listChangesAfter(user, "notebook-1", 0, 10);
  assert.equal(page.envelopes.length, 0);
  const acknowledgement = await service.acknowledgeHeads(user, {
    protocolVersion: 1,
    notebookId: "notebook-1",
    deviceId: "device-1",
    sequence: 0,
    documents: [],
  });
  assert.equal(acknowledgement.accepted, 0);
  await assert.rejects(service.appendChange(user, change()), ApiError);
});

test("removed members immediately lose authorization", async () => {
  const { memberships, service } = setup("editor");
  await service.registerDevice(user, deviceRegistration());
  await service.appendChange(user, change());
  memberships.remove("notebook-1", user.userId);
  await assert.rejects(
    service.appendChange(user, change({ changeHash: bytes(32, 9) })),
    (error: unknown) => error instanceof ApiError && error.status === 403,
  );
});

test("rejects forged and revoked device IDs on change, heads, assets, and key writes", async () => {
  const { service } = setup("owner");
  await service.registerDevice(user, deviceRegistration());
  await assert.rejects(
    service.appendChange(user, change({ deviceId: "device-forged" })),
    (error: unknown) => error instanceof ApiError && error.status === 403,
  );
  await service.revokeDevice(user, { deviceId: "device-1" });
  await assert.rejects(service.appendChange(user, change()), ApiError);
  await assert.rejects(
    service.acknowledgeHeads(user, {
      protocolVersion: 1,
      notebookId: "notebook-1",
      deviceId: "device-1",
      sequence: 0,
      documents: [],
    }),
    ApiError,
  );
  await assert.rejects(
    service.beginAssetUpload(user, assetUploadRequest()),
    ApiError,
  );
  await assert.rejects(service.putKeyEnvelope(user, keyEnvelope()), ApiError);
});

test("verifies asset upload authorization and permits only its exact replay", async () => {
  const { service } = setup("owner");
  await service.registerDevice(user, deviceRegistration());
  const request = assetUploadRequest();
  assert.equal(
    (await service.beginAssetUpload(user, request)).duplicate,
    false,
  );
  assert.equal((await service.beginAssetUpload(user, request)).duplicate, true);
  await assert.rejects(
    service.beginAssetUpload(user, {
      ...request,
      encryptedSize: request.encryptedSize + 1,
    }),
    (error: unknown) =>
      error instanceof ApiError && error.code === "invalid_signature",
  );
  await assert.rejects(
    service.beginAssetUpload(user, {
      ...request,
      deviceId: "another-device",
    }),
    (error: unknown) => error instanceof ApiError && error.status === 403,
  );
});

test("accepts only exact chunks from the still-active reservation device", async () => {
  const { service } = setup("owner");
  await service.registerDevice(user, deviceRegistration());
  const raw = Buffer.alloc(10, 21);
  const request = assetUploadRequest({
    encryptedHash: createHash("sha256").update(raw).digest("base64url"),
    encryptedSize: raw.byteLength,
  });
  const begun = await service.beginAssetUpload(user, request);
  const chunk = {
    ...request,
    assetId: begun.reservation.assetId,
    fileId: begun.reservation.fileId,
    chunkIndex: 0,
    chunkCount: 1,
    chunkHash: createHash("sha256").update(raw).digest("base64url"),
    chunkBytes: raw.toString("base64url"),
  };
  assert.equal((await service.uploadAssetChunk(user, chunk)).duplicate, false);
  await assert.rejects(
    service.uploadAssetChunk(user, {
      ...chunk,
      chunkHash: bytes(32, 22),
    }),
    (error: unknown) => error instanceof ApiError && error.status === 409,
  );
  await assert.rejects(
    service.uploadAssetChunk(user, { ...chunk, deviceId: "device-other" }),
    (error: unknown) => error instanceof ApiError && error.status === 403,
  );
  await service.revokeDevice(user, { deviceId: "device-1" });
  await assert.rejects(
    service.uploadAssetChunk(user, chunk),
    (error: unknown) => error instanceof ApiError && error.status === 403,
  );
});

test("device directory is account-private and notebook owners can revoke only current member devices", async () => {
  const { memberships, service } = setup("owner");
  const user2 = { userId: "user-2", jwt: "jwt-2" };
  await service.registerDevice(user, deviceRegistration());
  await service.registerDevice(
    user2,
    deviceRegistration({ deviceId: "device-2" }),
  );
  assert.deepEqual(
    (await service.listMyDevices(user, { limit: 50 })).devices.map(
      (device) => device.deviceId,
    ),
    ["device-1"],
  );
  await service.revokeDevice(user, {
    deviceId: "device-2",
    notebookId: "notebook-1",
  });
  assert.equal(
    (await service.listMyDevices(user2, { limit: 50 })).devices[0]?.status,
    "revoked",
  );

  await service.registerDevice(
    user2,
    deviceRegistration({ deviceId: "device-3" }),
  );
  memberships.set("notebook-1", "user-1", "editor");
  await assert.rejects(
    service.revokeDevice(user, {
      deviceId: "device-3",
      notebookId: "notebook-1",
    }),
    (error: unknown) => error instanceof ApiError && error.status === 403,
  );
  memberships.set("notebook-1", "user-1", "owner");
  memberships.remove("notebook-1", "user-2");
  await assert.rejects(
    service.revokeDevice(user, {
      deviceId: "device-3",
      notebookId: "notebook-1",
    }),
    (error: unknown) => error instanceof ApiError && error.status === 403,
  );
});

test("recipient-safe envelope discovery permits current owner/editor/viewer accounts but no cross-account enumeration", async () => {
  const memberships = new MemoryMemberships();
  memberships.set("notebook-1", "owner", "owner");
  memberships.set("notebook-1", "editor", "editor");
  memberships.set("notebook-1", "viewer", "viewer");
  const repository = new AppwriteSyncRepository(
    new MemoryDataPort(),
    new MemoryAssetPort(),
    {
      retryDelay: async () => undefined,
    },
  );
  const service = new SyncService(memberships, repository);
  const owner = { userId: "owner", jwt: "owner-jwt" };
  await service.registerDevice(
    owner,
    deviceRegistration({ deviceId: "owner-device" }),
  );

  for (const [index, accountId] of ["owner", "editor", "viewer"].entries()) {
    const envelope = resignKeyEnvelope({
      ...keyEnvelope(),
      keyEpoch: index + 1,
      senderDeviceId: "owner-device",
      senderEncryptionPublicKey: bytes(32, 21),
      recipient: { kind: "account", id: accountId },
      nonce: bytes(24, 40 + index),
      envelopeHash: bytes(32, 50 + index),
    });
    await service.putKeyEnvelope(owner, envelope);
    const recipient = { userId: accountId, jwt: `${accountId}-jwt` };
    const page = await service.listKeyEnvelopes(recipient, {
      notebookId: "notebook-1",
      recipient: { kind: "account", id: accountId },
      limit: 50,
    });
    assert.equal(page.envelopes.length, 1);
    assert.equal(page.envelopes[0]?.recipient.id, accountId);
  }

  await assert.rejects(
    service.listKeyEnvelopes(owner, {
      notebookId: "notebook-1",
      recipient: { kind: "account", id: "viewer" },
      limit: 50,
    }),
    (error: unknown) => error instanceof ApiError && error.status === 403,
  );
  memberships.remove("notebook-1", "viewer");
  await assert.rejects(
    service.listKeyEnvelopes(
      { userId: "viewer", jwt: "jwt" },
      {
        notebookId: "notebook-1",
        recipient: { kind: "account", id: "viewer" },
        limit: 50,
      },
    ),
    (error: unknown) => error instanceof ApiError && error.status === 403,
  );
});

test("device envelopes require an active owned recipient with the registered X25519 key", async () => {
  const { service } = setup("owner");
  const recipient = { userId: "user-2", jwt: "jwt-2" };
  await service.registerDevice(user, deviceRegistration());
  await service.registerDevice(
    recipient,
    deviceRegistration({
      deviceId: "device-2",
      encryptionPublicKey: bytes(32, 60),
      signingPublicKey: bytes(32, 61),
    }),
  );
  const envelope = resignKeyEnvelope({
    ...keyEnvelope(),
    recipient: { kind: "device", id: "device-2" },
    senderEncryptionPublicKey: bytes(32, 21),
    recipientEncryptionPublicKey: bytes(32, 60),
  });
  await service.putKeyEnvelope(user, envelope);
  assert.equal(
    (
      await service.listKeyEnvelopes(recipient, {
        notebookId: "notebook-1",
        recipient: { kind: "device", id: "device-2" },
        limit: 50,
      })
    ).envelopes.length,
    1,
  );
  await assert.rejects(
    service.putKeyEnvelope(
      user,
      resignKeyEnvelope({
        ...envelope,
        keyEpoch: 2,
        recipientEncryptionPublicKey: bytes(32, 62),
      }),
    ),
    (error: unknown) => error instanceof ApiError && error.code === "conflict",
  );
  await service.revokeDevice(recipient, { deviceId: "device-2" });
  await assert.rejects(
    service.listKeyEnvelopes(recipient, {
      notebookId: "notebook-1",
      recipient: { kind: "device", id: "device-2" },
      limit: 50,
    }),
    (error: unknown) => error instanceof ApiError && error.status === 403,
  );
});

test("rechecks notebook membership when consuming a previously issued approval", async () => {
  const { memberships, service } = setup("owner");
  await service.registerDevice(user, deviceRegistration());
  await service.registerDevice(
    user,
    deviceRegistration({ deviceId: "device-2" }),
  );
  const issued = await service.createDeviceApprovalChallenge(user, {
    protocolVersion: 1,
    notebookId: "notebook-1",
    requestingDeviceId: "device-2",
  });
  memberships.remove("notebook-1", user.userId);
  await assert.rejects(
    service.activateDevice(user, {
      challengeId: issued.challengeId,
      proof: approvalProof(issued.challenge),
    }),
    (error: unknown) => error instanceof ApiError && error.status === 403,
  );
});

test("lists recovery envelopes with sender signing metadata and rechecks membership before recovery activation", async () => {
  const { memberships, service } = setup("owner");
  await service.registerDevice(user, deviceRegistration());
  await service.registerDevice(
    user,
    deviceRegistration({ deviceId: "device-2" }),
  );
  await service.putKeyEnvelope(user, recoveryEnvelope());
  const listed = await service.listKeyEnvelopes(user, {
    notebookId: "notebook-1",
    recipient: { kind: "recovery", id: "recovery-1" },
    limit: 50,
  });
  assert.equal(listed.envelopes.length, 1);
  assert.equal(
    listed.envelopes[0]?.senderSigningPublicKey,
    deviceRegistration().signingPublicKey,
  );

  const issued = await service.createDeviceApprovalChallenge(user, {
    protocolVersion: 1,
    notebookId: "notebook-1",
    requestingDeviceId: "device-2",
  });
  const request = {
    challengeId: issued.challengeId,
    proof: recoveryApprovalProof(issued.challenge),
  };
  memberships.remove("notebook-1", user.userId);
  await assert.rejects(
    service.activateDeviceWithRecovery(user, request),
    (error: unknown) => error instanceof ApiError && error.status === 403,
  );
  memberships.set("notebook-1", user.userId, "owner");
  assert.equal(
    (await service.activateDeviceWithRecovery(user, request)).device.status,
    "active",
  );
});

test("rejects tampered change and notebook-key envelope signatures before storage", async () => {
  const { service } = setup("owner");
  await service.registerDevice(user, deviceRegistration());
  await assert.rejects(
    service.appendChange(user, change({ signature: bytes(64, 70) })),
    (error: unknown) =>
      error instanceof ApiError && error.code === "invalid_signature",
  );
  await assert.rejects(
    service.putKeyEnvelope(user, {
      ...keyEnvelope(),
      signature: bytes(64, 71),
    }),
    (error: unknown) =>
      error instanceof ApiError && error.code === "invalid_signature",
  );
});

test("notebook device directory is membership-gated, active-only, and excludes removed accounts", async () => {
  const { memberships, service } = setup("owner");
  const user2 = { userId: "user-2", jwt: "jwt-2" };
  await service.registerDevice(user, deviceRegistration());
  await service.registerDevice(
    user2,
    deviceRegistration({ deviceId: "device-2" }),
  );
  await service.registerDevice(
    user2,
    deviceRegistration({ deviceId: "device-3" }),
  );
  const initial = await service.listNotebookDevices(user, {
    notebookId: "notebook-1",
    limit: 50,
  });
  assert.deepEqual(initial.devices.map((device) => device.deviceId).sort(), [
    "device-1",
    "device-2",
  ]);
  memberships.remove("notebook-1", "user-2");
  const afterRemoval = await service.listNotebookDevices(user, {
    notebookId: "notebook-1",
    limit: 50,
  });
  assert.deepEqual(
    afterRemoval.devices.map((device) => device.deviceId),
    ["device-1"],
  );
  await assert.rejects(
    service.listNotebookDevices(user2, { notebookId: "notebook-1", limit: 50 }),
    (error: unknown) => error instanceof ApiError && error.status === 403,
  );
});
