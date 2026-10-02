import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  AppwriteSyncRepository,
  RESOURCE_IDS,
} from "../src/appwriteRepository.js";
import type {
  HeadsAcknowledgement,
  NotebookKeyEnvelope,
} from "../src/contracts.js";
import { ApiError } from "../src/errors.js";
import {
  assetUploadRequest,
  approvalProof,
  bytes,
  change,
  deviceRegistration,
  MemoryAssetPort,
  MemoryDataPort,
  recoveryApprovalProof,
  TEST_RECOVERY_SIGNING_PUBLIC_KEY,
} from "./helpers.js";

function repository(
  data = new MemoryDataPort(),
  assets = new MemoryAssetPort(),
  now: () => Date = () => new Date("2026-08-03T12:00:00.000Z"),
) {
  return {
    data,
    assets,
    repository: new AppwriteSyncRepository(data, assets, {
      now,
      retryDelay: async () => undefined,
    }),
  };
}

test("allows one atomic account bootstrap and leaves every later device pending", async () => {
  const context = repository();
  const first = await context.repository.registerDevice(
    "user-1",
    deviceRegistration(),
  );
  const second = await context.repository.registerDevice(
    "user-1",
    deviceRegistration({ deviceId: "device-2" }),
  );
  assert.equal(first.bootstrap, true);
  assert.equal(first.device.status, "active");
  assert.equal(second.bootstrap, false);
  assert.equal(second.device.status, "pending");
});

test("allows exactly one bootstrap when the first two registrations race", async () => {
  const context = repository();
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstTransaction: string | undefined;
  let enteredFirst!: () => void;
  const firstEntered = new Promise<void>((resolve) => {
    enteredFirst = resolve;
  });
  context.data.beforeCommit = async (transactionId) => {
    if (firstTransaction === undefined) {
      firstTransaction = transactionId;
      enteredFirst();
      await firstBlocked;
    }
  };

  const one = context.repository.registerDevice(
    "user-1",
    deviceRegistration({ deviceId: "device-a" }),
  );
  await firstEntered;
  const two = await context.repository.registerDevice(
    "user-1",
    deviceRegistration({ deviceId: "device-b" }),
  );
  releaseFirst();
  const first = await one;

  const registrations = [first, two];
  assert.equal(registrations.filter((result) => result.bootstrap).length, 1);
  assert.equal(
    registrations.filter((result) => result.device.status === "active").length,
    1,
  );
  assert.equal(
    registrations.filter((result) => result.device.status === "pending").length,
    1,
  );
});

test("bounds the number of live approval challenges for one pending device", async () => {
  const context = repository();
  await context.repository.registerDevice("user-1", deviceRegistration());
  await context.repository.registerDevice(
    "user-1",
    deviceRegistration({ deviceId: "device-2" }),
  );
  const request = {
    protocolVersion: 1 as const,
    notebookId: "notebook-1",
    requestingDeviceId: "device-2",
  };
  await context.repository.createDeviceApprovalChallenge("user-1", request);
  await context.repository.createDeviceApprovalChallenge("user-1", request);
  await context.repository.createDeviceApprovalChallenge("user-1", request);
  await assert.rejects(
    context.repository.createDeviceApprovalChallenge("user-1", request),
    (error: unknown) =>
      error instanceof ApiError && error.code === "too_many_challenges",
  );
});

test("atomically consumes a valid approval once and accepts only its exact retry", async () => {
  const context = repository();
  await context.repository.registerDevice("user-1", deviceRegistration());
  await context.repository.registerDevice(
    "user-1",
    deviceRegistration({ deviceId: "device-2" }),
  );
  const issued = await context.repository.createDeviceApprovalChallenge(
    "user-1",
    {
      protocolVersion: 1,
      notebookId: "notebook-1",
      requestingDeviceId: "device-2",
    },
  );
  const proof = approvalProof(issued.challenge);
  await assert.rejects(
    context.repository.activateDevice("user-1", {
      challengeId: issued.challengeId,
      proof: approvalProof(issued.challenge, "missing-device"),
    }),
    (error: unknown) => error instanceof ApiError && error.code === "conflict",
  );
  await assert.rejects(
    context.repository.activateDevice("user-1", {
      challengeId: issued.challengeId,
      proof: { ...proof, signature: bytes(64, 91) },
    }),
    (error: unknown) =>
      error instanceof ApiError && error.code === "invalid_signature",
  );
  assert.equal(
    (await context.repository.getDevice("device-2"))?.status,
    "pending",
  );
  const activated = await context.repository.activateDevice("user-1", {
    challengeId: issued.challengeId,
    proof,
  });
  assert.equal(activated.device.status, "active");
  assert.equal(activated.duplicate, false);
  assert.equal(
    (
      await context.repository.activateDevice("user-1", {
        challengeId: issued.challengeId,
        proof,
      })
    ).duplicate,
    true,
  );
  await assert.rejects(
    context.repository.activateDevice("user-1", {
      challengeId: issued.challengeId,
      proof: { ...proof, signature: bytes(64, 90) },
    }),
    (error: unknown) => error instanceof ApiError && error.code === "conflict",
  );
});

test("rejects expired approvals, wrong accounts, and inactive approvers", async () => {
  let now = new Date("2026-08-03T12:00:00.000Z");
  const context = repository(
    new MemoryDataPort(),
    new MemoryAssetPort(),
    () => now,
  );
  await context.repository.registerDevice("user-1", deviceRegistration());
  await context.repository.registerDevice(
    "user-1",
    deviceRegistration({ deviceId: "device-2" }),
  );
  const expired = await context.repository.createDeviceApprovalChallenge(
    "user-1",
    {
      protocolVersion: 1,
      notebookId: "notebook-1",
      requestingDeviceId: "device-2",
    },
  );
  const expiredProof = approvalProof(expired.challenge);
  now = new Date(expired.challenge.expiresAt + 1);
  await assert.rejects(
    context.repository.activateDevice("user-1", {
      challengeId: expired.challengeId,
      proof: expiredProof,
    }),
    (error: unknown) =>
      error instanceof ApiError && error.code === "approval_expired",
  );
  await assert.rejects(
    context.repository.activateDevice("user-2", {
      challengeId: expired.challengeId,
      proof: expiredProof,
    }),
    (error: unknown) => error instanceof ApiError && error.status === 403,
  );

  now = new Date("2026-08-03T13:00:00.000Z");
  const inactive = await context.repository.createDeviceApprovalChallenge(
    "user-1",
    {
      protocolVersion: 1,
      notebookId: "notebook-1",
      requestingDeviceId: "device-2",
    },
  );
  await context.repository.revokeDevice("device-1");
  await assert.rejects(
    context.repository.activateDevice("user-1", {
      challengeId: inactive.challengeId,
      proof: approvalProof(inactive.challenge),
    }),
    (error: unknown) => error instanceof ApiError && error.status === 403,
  );
});

test("activates a pending device with one replay-safe recovery proof", async () => {
  const context = repository();
  await context.repository.registerDevice("user-1", deviceRegistration());
  await context.repository.registerDevice(
    "user-1",
    deviceRegistration({ deviceId: "device-2" }),
  );
  await context.repository.putKeyEnvelope({
    protocolVersion: 1,
    notebookId: "notebook-1",
    keyEpoch: 1,
    senderDeviceId: "device-1",
    recipient: { kind: "recovery", id: "recovery-1" },
    senderEncryptionPublicKey: bytes(32, 21),
    recipientEncryptionPublicKey: bytes(32, 22),
    recoverySigningPublicKey: TEST_RECOVERY_SIGNING_PUBLIC_KEY,
    nonce: bytes(24, 23),
    ciphertext: bytes(48, 24),
    signature: bytes(64, 25),
    envelopeHash: bytes(32, 26),
  });
  const issued = await context.repository.createDeviceApprovalChallenge(
    "user-1",
    {
      protocolVersion: 1,
      notebookId: "notebook-1",
      requestingDeviceId: "device-2",
    },
  );
  await assert.rejects(
    context.repository.activateDeviceWithRecovery("user-2", {
      challengeId: issued.challengeId,
      proof: recoveryApprovalProof(issued.challenge),
    }),
    (error: unknown) => error instanceof ApiError && error.status === 403,
  );
  await assert.rejects(
    context.repository.activateDeviceWithRecovery("user-1", {
      challengeId: issued.challengeId,
      proof: recoveryApprovalProof(issued.challenge, "wrong-recovery-key"),
    }),
    (error: unknown) =>
      error instanceof ApiError && error.code === "invalid_approval",
  );
  const proof = recoveryApprovalProof(issued.challenge);
  await assert.rejects(
    context.repository.activateDeviceWithRecovery("user-1", {
      challengeId: issued.challengeId,
      proof: { ...proof, signature: bytes(64, 88) },
    }),
    (error: unknown) =>
      error instanceof ApiError && error.code === "invalid_signature",
  );
  const activated = await context.repository.activateDeviceWithRecovery(
    "user-1",
    {
      challengeId: issued.challengeId,
      proof,
    },
  );
  assert.equal(activated.device.status, "active");
  assert.equal(activated.duplicate, false);
  assert.equal(
    (
      await context.repository.activateDeviceWithRecovery("user-1", {
        challengeId: issued.challengeId,
        proof,
      })
    ).duplicate,
    true,
  );
  await assert.rejects(
    context.repository.activateDeviceWithRecovery("user-1", {
      challengeId: issued.challengeId,
      proof: { ...proof, signature: bytes(64, 87) },
    }),
    (error: unknown) => error instanceof ApiError && error.code === "conflict",
  );
});

test("rejects an expired recovery activation proof", async () => {
  let now = new Date("2026-08-03T12:00:00.000Z");
  const context = repository(
    new MemoryDataPort(),
    new MemoryAssetPort(),
    () => now,
  );
  await context.repository.registerDevice("user-1", deviceRegistration());
  await context.repository.registerDevice(
    "user-1",
    deviceRegistration({ deviceId: "device-2" }),
  );
  await context.repository.putKeyEnvelope({
    protocolVersion: 1,
    notebookId: "notebook-1",
    keyEpoch: 1,
    senderDeviceId: "device-1",
    recipient: { kind: "recovery", id: "recovery-1" },
    senderEncryptionPublicKey: bytes(32, 21),
    recipientEncryptionPublicKey: bytes(32, 22),
    recoverySigningPublicKey: TEST_RECOVERY_SIGNING_PUBLIC_KEY,
    nonce: bytes(24, 23),
    ciphertext: bytes(48, 24),
    signature: bytes(64, 25),
    envelopeHash: bytes(32, 26),
  });
  const issued = await context.repository.createDeviceApprovalChallenge(
    "user-1",
    {
      protocolVersion: 1,
      notebookId: "notebook-1",
      requestingDeviceId: "device-2",
    },
  );
  now = new Date(issued.challenge.expiresAt + 1);
  await assert.rejects(
    context.repository.activateDeviceWithRecovery("user-1", {
      challengeId: issued.challengeId,
      proof: recoveryApprovalProof(issued.challenge),
    }),
    (error: unknown) =>
      error instanceof ApiError && error.code === "approval_expired",
  );
});

test("rejects conflicting recovery signing keys for the same recovery identity", async () => {
  const context = repository();
  await context.repository.registerDevice("user-1", deviceRegistration());
  await context.repository.registerDevice(
    "user-1",
    deviceRegistration({ deviceId: "device-2" }),
  );
  const base: NotebookKeyEnvelope = {
    protocolVersion: 1,
    notebookId: "notebook-1",
    keyEpoch: 1,
    senderDeviceId: "device-1",
    recipient: { kind: "recovery", id: "recovery-1" },
    senderEncryptionPublicKey: bytes(32, 21),
    recipientEncryptionPublicKey: bytes(32, 22),
    recoverySigningPublicKey: TEST_RECOVERY_SIGNING_PUBLIC_KEY,
    nonce: bytes(24, 23),
    ciphertext: bytes(48, 24),
    signature: bytes(64, 25),
    envelopeHash: bytes(32, 26),
  };
  await context.repository.putKeyEnvelope(base);
  await context.repository.putKeyEnvelope({
    ...base,
    keyEpoch: 2,
    recoverySigningPublicKey: bytes(32, 99),
    envelopeHash: bytes(32, 98),
  });
  const issued = await context.repository.createDeviceApprovalChallenge(
    "user-1",
    {
      protocolVersion: 1,
      notebookId: "notebook-1",
      requestingDeviceId: "device-2",
    },
  );
  await assert.rejects(
    context.repository.activateDeviceWithRecovery("user-1", {
      challengeId: issued.challengeId,
      proof: recoveryApprovalProof(issued.challenge),
    }),
    (error: unknown) => error instanceof ApiError && error.code === "conflict",
  );
});

test("binds device IDs and public keys to one account without allowing reactivation or rebinding", async () => {
  const context = repository();
  const registered = await context.repository.registerDevice(
    "user-1",
    deviceRegistration(),
  );
  assert.equal(registered.duplicate, false);
  assert.equal(registered.device.status, "active");
  assert.equal(
    (await context.repository.registerDevice("user-1", deviceRegistration()))
      .duplicate,
    true,
  );
  await assert.rejects(
    context.repository.registerDevice("user-2", deviceRegistration()),
    (error: unknown) => error instanceof ApiError && error.code === "conflict",
  );
  await assert.rejects(
    context.repository.registerDevice(
      "user-1",
      deviceRegistration({ signingPublicKey: bytes(32, 99) }),
    ),
    (error: unknown) => error instanceof ApiError && error.code === "conflict",
  );
  await context.repository.revokeDevice("device-1");
  const retry = await context.repository.registerDevice(
    "user-1",
    deviceRegistration(),
  );
  assert.equal(retry.duplicate, true);
  assert.equal(retry.device.status, "revoked");
});

test("lists only the account device directory with bounded cursor pagination", async () => {
  const context = repository();
  await context.repository.registerDevice(
    "user-1",
    deviceRegistration({ deviceId: "device-a" }),
  );
  await context.repository.registerDevice(
    "user-1",
    deviceRegistration({ deviceId: "device-b" }),
  );
  await context.repository.registerDevice(
    "user-2",
    deviceRegistration({ deviceId: "device-other" }),
  );
  const first = await context.repository.listMyDevices("user-1", { limit: 1 });
  assert.equal(first.devices.length, 1);
  assert.ok(first.nextCursor);
  const second = await context.repository.listMyDevices("user-1", {
    limit: 1,
    cursor: first.nextCursor,
  });
  assert.equal(second.devices.length, 1);
  assert.notEqual(second.devices[0]?.deviceId, first.devices[0]?.deviceId);
  assert.equal(second.nextCursor, undefined);
  assert.ok(
    [...first.devices, ...second.devices].every(
      (device) => device.deviceId !== "device-other",
    ),
  );
});

test("lists recipient envelopes across epochs while excluding account, device, and recovery siblings", async () => {
  const context = repository();
  await context.repository.registerDevice("user-1", deviceRegistration());
  const base: NotebookKeyEnvelope = {
    protocolVersion: 1,
    notebookId: "notebook-1",
    keyEpoch: 1,
    senderDeviceId: "device-1",
    recipient: { kind: "device", id: "device-2" },
    senderEncryptionPublicKey: bytes(32, 1),
    recipientEncryptionPublicKey: bytes(32, 2),
    nonce: bytes(24, 3),
    ciphertext: bytes(48, 4),
    signature: bytes(64, 5),
    envelopeHash: bytes(32, 6),
  };
  await context.repository.putKeyEnvelope(base);
  await context.repository.putKeyEnvelope({
    ...base,
    keyEpoch: 2,
    nonce: bytes(24, 7),
    envelopeHash: bytes(32, 8),
  });
  await context.repository.putKeyEnvelope({
    ...base,
    recipient: { kind: "account", id: "user-2" },
    envelopeHash: bytes(32, 9),
  });
  await context.repository.putKeyEnvelope({
    ...base,
    recipient: { kind: "recovery", id: "recovery-1" },
    envelopeHash: bytes(32, 10),
  });
  await context.repository.revokeDevice("device-1");
  const first = await context.repository.listKeyEnvelopes({
    notebookId: "notebook-1",
    recipient: { kind: "device", id: "device-2" },
    limit: 1,
  });
  assert.deepEqual(
    first.envelopes.map((envelope) => envelope.keyEpoch),
    [1],
  );
  assert.equal(
    first.envelopes[0]?.senderSigningPublicKey,
    deviceRegistration().signingPublicKey,
  );
  assert.ok(first.nextCursor);
  const second = await context.repository.listKeyEnvelopes({
    notebookId: "notebook-1",
    recipient: { kind: "device", id: "device-2" },
    limit: 1,
    cursor: first.nextCursor,
  });
  assert.deepEqual(
    second.envelopes.map((envelope) => envelope.keyEpoch),
    [2],
  );
  assert.ok(
    [...first.envelopes, ...second.envelopes].every(
      (envelope) => envelope.recipient.kind === "device",
    ),
  );
});

test("allocates contiguous notebook-global sequences and catches up in order", async () => {
  const context = repository();
  const first = await context.repository.appendChange(change(), "user-1");
  const second = await context.repository.appendChange(
    change({
      deviceId: "device-2",
      changeHash: bytes(32, 5),
    }),
    "user-2",
  );
  assert.equal(first.envelope.sequence, 1);
  assert.equal(second.envelope.sequence, 2);

  const page = await context.repository.listChangesAfter("notebook-1", 0, 1);
  assert.deepEqual(
    page.envelopes.map((envelope) => envelope.sequence),
    [1],
  );
  assert.deepEqual(
    page.envelopes.map((envelope) => envelope.keyEpoch),
    [1],
  );
  assert.equal(page.snapshotSequence, 2);
  assert.equal(page.hasMore, true);
});

test("returns the committed envelope after a lost commit acknowledgement", async () => {
  const context = repository();
  context.data.loseNextCommitAcknowledgement = true;
  const result = await context.repository.appendChange(change(), "user-1");
  assert.equal(result.duplicate, true);
  assert.equal(result.envelope.sequence, 1);
  assert.equal(
    context.data.read(RESOURCE_IDS.notebooks, "notebook-1")?.currentSequence,
    1,
  );
});

test("retries a counter race without assigning duplicate or skipped sequences", async () => {
  const context = repository();
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstTransaction: string | undefined;
  let enteredFirst!: () => void;
  const firstEntered = new Promise<void>((resolve) => {
    enteredFirst = resolve;
  });
  context.data.beforeCommit = async (transactionId) => {
    if (firstTransaction === undefined) {
      firstTransaction = transactionId;
      enteredFirst();
      await firstBlocked;
    }
  };

  const one = context.repository.appendChange(change(), "user-1");
  await firstEntered;
  const two = context.repository.appendChange(
    change({ deviceId: "device-2", changeHash: bytes(32, 6) }),
    "user-2",
  );
  const second = await two;
  releaseFirst();
  const first = await one;
  assert.deepEqual(
    [first.envelope.sequence, second.envelope.sequence].sort(),
    [1, 2],
  );
});

test("treats exact replay as idempotent and rejects a changed envelope under the same device/hash", async () => {
  const context = repository();
  await context.repository.appendChange(change(), "user-1");
  const replay = await context.repository.appendChange(change(), "user-1");
  assert.equal(replay.duplicate, true);
  await assert.rejects(
    context.repository.appendChange(
      change({ ciphertext: bytes(48, 9) }),
      "user-1",
    ),
    (error: unknown) => error instanceof ApiError && error.code === "conflict",
  );
  await assert.rejects(
    context.repository.appendChange(change({ keyEpoch: 2 }), "user-1"),
    (error: unknown) => error instanceof ApiError && error.code === "conflict",
  );
});

test("rejects future, stale, and tampered heads while allowing exact duplicate acknowledgement", async () => {
  const context = repository();
  await context.repository.appendChange(change(), "user-1");
  const acknowledgement: HeadsAcknowledgement = {
    protocolVersion: 1,
    notebookId: "notebook-1",
    deviceId: "device-1",
    sequence: 1,
    documents: [{ documentId: "page-1", heads: [bytes(32, 7)] }],
  };
  assert.equal(
    (await context.repository.acknowledgeHeads(acknowledgement)).accepted,
    1,
  );
  assert.equal(
    (await context.repository.acknowledgeHeads(acknowledgement)).accepted,
    0,
  );
  await assert.rejects(
    context.repository.acknowledgeHeads({
      ...acknowledgement,
      documents: [{ documentId: "page-1", heads: [bytes(32, 8)] }],
    }),
    ApiError,
  );
  await assert.rejects(
    context.repository.acknowledgeHeads({ ...acknowledgement, sequence: 2 }),
    ApiError,
  );
});

test("stores key envelopes idempotently and rejects recipient-slot rebinding", async () => {
  const context = repository();
  const envelope: NotebookKeyEnvelope = {
    protocolVersion: 1,
    notebookId: "notebook-1",
    keyEpoch: 1,
    senderDeviceId: "device-1",
    recipient: { kind: "account", id: "user-2" },
    senderEncryptionPublicKey: bytes(32, 1),
    recipientEncryptionPublicKey: bytes(32, 6),
    nonce: bytes(24, 2),
    ciphertext: bytes(48, 3),
    signature: bytes(64, 4),
    envelopeHash: bytes(32, 5),
  };
  assert.equal(
    (await context.repository.putKeyEnvelope(envelope)).duplicate,
    false,
  );
  assert.equal(
    (await context.repository.putKeyEnvelope(envelope)).duplicate,
    true,
  );
  await assert.rejects(
    context.repository.putKeyEnvelope({
      ...envelope,
      ciphertext: bytes(48, 10),
    }),
    ApiError,
  );
  await assert.rejects(
    context.repository.putKeyEnvelope({
      ...envelope,
      recipientEncryptionPublicKey: bytes(32, 11),
    }),
    ApiError,
  );
});

test("completes only uploaded encrypted assets whose bytes match the reservation", async () => {
  const context = repository();
  const request = assetUploadRequest({
    encryptedHash: bytes(32, 11),
    encryptedSize: 2048,
  });
  const begun = await context.repository.beginAssetUpload(request);
  context.assets.files.set(begun.reservation.fileId, {
    encryptedHash: request.encryptedHash,
    encryptedSize: request.encryptedSize,
  });
  const completion = {
    ...request,
    assetId: begun.reservation.assetId,
    fileId: begun.reservation.fileId,
  };
  assert.equal(
    (await context.repository.completeAssetUpload(completion)).duplicate,
    false,
  );
  assert.equal(
    context.assets.sealed.get(begun.reservation.fileId),
    "notebook-1",
  );
  assert.equal(
    (await context.repository.completeAssetUpload(completion)).duplicate,
    true,
  );
});

test("rejects mismatched encrypted asset bytes", async () => {
  const context = repository();
  const request = assetUploadRequest({
    encryptedHash: bytes(32, 12),
    encryptedSize: 2048,
  });
  const begun = await context.repository.beginAssetUpload(request);
  context.assets.files.set(begun.reservation.fileId, {
    encryptedHash: bytes(32, 13),
    encryptedSize: 2048,
  });
  await assert.rejects(
    context.repository.completeAssetUpload({
      ...request,
      assetId: begun.reservation.assetId,
      fileId: begun.reservation.fileId,
    }),
    ApiError,
  );
});

test("bounds pending asset reservations per device", async () => {
  const context = repository();
  for (let index = 0; index < 16; index += 1) {
    await context.repository.beginAssetUpload(
      assetUploadRequest({ encryptedHash: bytes(32, index + 1) }),
    );
  }
  await assert.rejects(
    context.repository.beginAssetUpload(
      assetUploadRequest({ encryptedHash: bytes(32, 99) }),
    ),
    (error: unknown) => error instanceof ApiError && error.status === 429,
  );
});

test("bounds pending asset reservations per notebook", async () => {
  const context = repository();
  for (let index = 0; index < 64; index += 1) {
    await context.repository.beginAssetUpload(
      assetUploadRequest({
        deviceId: `device-${index}`,
        encryptedHash: bytes(32, index + 1),
      }),
    );
  }
  await assert.rejects(
    context.repository.beginAssetUpload(
      assetUploadRequest({ encryptedHash: bytes(32, 100) }),
    ),
    (error: unknown) => error instanceof ApiError && error.status === 429,
  );
});

test("opportunistically removes only a bounded batch of expired reservations and orphan files", async () => {
  const context = repository();
  for (let index = 0; index < 30; index += 1) {
    const rowId = `expired-${index}`;
    context.data.seed(RESOURCE_IDS.assets, rowId, {
      ...assetUploadRequest({ encryptedHash: bytes(32, index + 1) }),
      fileId: rowId,
      chunkCount: 1,
      status: "pending",
      expiresAt: "2026-08-03T11:00:00.000Z",
    });
    context.assets.files.set(rowId, {
      encryptedHash: bytes(32, index + 1),
      encryptedSize: 10,
    });
  }
  await context.repository.beginAssetUpload(
    assetUploadRequest({ encryptedHash: bytes(32, 100) }),
  );
  const remaining = Array.from(
    { length: 30 },
    (_, index) => `expired-${index}`,
  ).filter((rowId) => context.data.read(RESOURCE_IDS.assets, rowId) !== null);
  assert.equal(remaining.length, 5);
  assert.equal(context.assets.files.size, 5);
});

test("serializes parallel device quota allocation and accepts exactly sixteen reservations", async () => {
  const context = repository();
  const results = await Promise.allSettled(
    Array.from({ length: 17 }, (_, index) =>
      context.repository.beginAssetUpload(
        assetUploadRequest({ encryptedHash: bytes(32, index + 1) }),
      ),
    ),
  );
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    16,
  );
  const rejected = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0]?.reason instanceof ApiError);
  assert.equal((rejected[0]?.reason as ApiError).status, 429);
});

test("never reconciles a cross-device asset identity race to the foreign reservation", async () => {
  const context = repository();
  const encryptedHash = bytes(32, 71);
  const results = await Promise.allSettled([
    context.repository.beginAssetUpload(
      assetUploadRequest({ deviceId: "device-a", encryptedHash }),
    ),
    context.repository.beginAssetUpload(
      assetUploadRequest({ deviceId: "device-b", encryptedHash }),
    ),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const rejected = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  assert.ok(rejected?.reason instanceof ApiError);
  assert.equal(rejected.reason.status, 409);
});

test("keeps pending reservation and quota metadata Function-private", async () => {
  const context = repository();
  const begun = await context.repository.beginAssetUpload(assetUploadRequest());
  const reservation = context.data.read(
    RESOURCE_IDS.assets,
    begun.reservation.assetId,
  );
  assert.deepEqual(reservation?.$permissions, []);
});

test("stages exact chunks idempotently and rejects changed bytes", async () => {
  const context = repository();
  const raw = Buffer.alloc(10, 7);
  const request = assetUploadRequest({
    encryptedHash: createHash("sha256").update(raw).digest("base64url"),
    encryptedSize: raw.byteLength,
  });
  const begun = await context.repository.beginAssetUpload(request);
  const chunk = {
    ...request,
    assetId: begun.reservation.assetId,
    fileId: begun.reservation.fileId,
    chunkIndex: 0,
    chunkCount: 1,
    chunkHash: createHash("sha256").update(raw).digest("base64url"),
    chunkBytes: raw.toString("base64url"),
  };
  assert.equal((await context.repository.uploadAssetChunk(chunk)).duplicate, false);
  assert.equal((await context.repository.uploadAssetChunk(chunk)).duplicate, true);
  await assert.rejects(
    context.repository.uploadAssetChunk({
      ...chunk,
      chunkHash: bytes(32, 8),
      chunkBytes: Buffer.alloc(10, 8).toString("base64url"),
    }),
  );
});

test("an active completion lease prevents expiry cleanup from deleting its bytes", async () => {
  let current = new Date("2026-08-03T12:00:00.000Z");
  const context = repository(undefined, undefined, () => current);
  const request = assetUploadRequest({ encryptedHash: bytes(32, 83) });
  const begun = await context.repository.beginAssetUpload(request);
  context.assets.files.set(begun.reservation.fileId, {
    encryptedHash: request.encryptedHash,
    encryptedSize: request.encryptedSize,
  });
  current = new Date("2026-08-04T11:59:00.000Z");
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const assembling = new Promise<void>((resolve) => {
    entered = resolve;
  });
  context.assets.beforeAssemble = async () => {
    entered();
    await blocked;
  };
  const completion = context.repository.completeAssetUpload({
    ...request,
    assetId: begun.reservation.assetId,
    fileId: begun.reservation.fileId,
  });
  await assembling;
  current = new Date("2026-08-04T12:01:00.000Z");
  await context.repository.beginAssetUpload(
    assetUploadRequest({ encryptedHash: bytes(32, 84) }),
  );
  assert.equal(
    context.data.read(RESOURCE_IDS.assets, begun.reservation.assetId)?.status,
    "uploading",
  );
  assert.ok(context.assets.files.has(begun.reservation.fileId));
  release();
  assert.equal((await completion).reservation.status, "complete");
});
