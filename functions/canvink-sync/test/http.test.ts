import assert from "node:assert/strict";
import { test } from "node:test";
import { AppwriteSyncRepository } from "../src/appwriteRepository.js";
import { createHandler } from "../src/main.js";
import { SyncService } from "../src/service.js";
import {
  bytes,
  change,
  deviceRegistration,
  MemoryAssetPort,
  MemoryDataPort,
  MemoryMemberships,
} from "./helpers.js";

async function setup() {
  const memberships = new MemoryMemberships();
  memberships.set("notebook-1", "user-1", "owner");
  const repository = new AppwriteSyncRepository(
    new MemoryDataPort(),
    new MemoryAssetPort(),
    { retryDelay: async () => undefined },
  );
  const service = new SyncService(memberships, repository);
  await service.registerDevice(
    { userId: "user-1", jwt: "jwt" },
    deviceRegistration(),
  );
  return createHandler({
    identity: { verify: async () => "user-1" },
    service,
    allowedOrigins: new Set(["https://canvink.example"]),
  });
}

async function execute(
  overrides: Partial<{
    method: string;
    path: string;
    bodyText: string;
    headers: Record<string, string>;
  }> = {},
) {
  let captured:
    | { body: unknown; status: number; headers: Record<string, string> }
    | undefined;
  const logs: string[] = [];
  const errors: string[] = [];
  const handler = await setup();
  await handler({
    req: {
      method: overrides.method ?? "POST",
      path: overrides.path ?? "/appendChange",
      bodyText: overrides.bodyText ?? JSON.stringify(change()),
      headers: overrides.headers ?? {
        "content-type": "application/json",
        "x-appwrite-user-id": "user-1",
        "x-appwrite-user-jwt": "jwt",
      },
    },
    res: {
      json(body: unknown, status = 200, headers: Record<string, string> = {}) {
        captured = { body, status, headers };
        return captured;
      },
    },
    log: (message: string) => logs.push(message),
    error: (message: string) => errors.push(message),
  });
  assert.ok(captured);
  return { response: captured, logs, errors };
}

test("requires POST and verified Appwrite identity headers", async () => {
  assert.equal((await execute({ method: "GET" })).response.status, 405);
  assert.equal(
    (await execute({ headers: { "content-type": "application/json" } }))
      .response.status,
    401,
  );
});

test("rejects request bodies above the exact 6 MiB Function boundary", async () => {
  const result = await execute({
    bodyText: "x".repeat(6 * 1024 * 1024 + 1),
  });
  assert.equal(result.response.status, 413);
  assert.equal(
    (result.response.body as { error: { code: string } }).error.code,
    "payload_too_large",
  );
});

test("allows exact configured CORS origins and rejects other browser origins", async () => {
  const preflight = await execute({
    method: "OPTIONS",
    headers: { origin: "https://canvink.example" },
  });
  assert.equal(preflight.response.status, 204);
  assert.equal(
    preflight.response.headers["Access-Control-Allow-Origin"],
    "https://canvink.example",
  );

  const rejected = await execute({
    headers: {
      origin: "https://evil.example",
      "content-type": "application/json",
      "x-appwrite-user-id": "user-1",
      "x-appwrite-user-jwt": "jwt",
    },
  });
  assert.equal(rejected.response.status, 403);
  assert.equal(
    rejected.response.headers["Access-Control-Allow-Origin"],
    undefined,
  );
});

test("returns only opaque envelope data and logs no identifiers or encrypted payloads", async () => {
  const result = await execute();
  assert.equal(result.response.status, 200);
  const serializedLogs = [...result.logs, ...result.errors].join("\n");
  assert.doesNotMatch(serializedLogs, /notebook-1|device-1|page-1/u);
  assert.doesNotMatch(serializedLogs, new RegExp(change().ciphertext, "u"));
});

test("rejects non-JSON and unknown routes with bounded public errors", async () => {
  assert.equal(
    (
      await execute({
        headers: {
          "content-type": "text/plain",
          "x-appwrite-user-id": "user-1",
          "x-appwrite-user-jwt": "jwt",
        },
      })
    ).response.status,
    415,
  );
  assert.equal((await execute({ path: "/unknown" })).response.status, 404);
});

test("routes account-bound device discovery without accepting a caller-supplied account ID", async () => {
  const registered = await execute({
    path: "/registerDevice",
    bodyText: JSON.stringify(deviceRegistration()),
  });
  assert.equal(registered.response.status, 200);
  assert.doesNotMatch(JSON.stringify(registered.response.body), /accountId/u);

  const listed = await execute({
    path: "/listMyDevices",
    bodyText: JSON.stringify({ limit: 10 }),
  });
  assert.equal(listed.response.status, 200);
  assert.match(JSON.stringify(listed.response.body), /device-1/u);

  const forged = await execute({
    path: "/registerDevice",
    bodyText: JSON.stringify({ ...deviceRegistration(), accountId: "user-2" }),
  });
  assert.equal(forged.response.status, 400);
});

test("routes approval and notebook public-device discovery through authenticated handlers", async () => {
  const directory = await execute({
    path: "/listNotebookDevices",
    bodyText: JSON.stringify({ notebookId: "notebook-1", limit: 10 }),
  });
  assert.equal(directory.response.status, 200);
  assert.match(JSON.stringify(directory.response.body), /device-1/u);

  const activeCannotRequest = await execute({
    path: "/createDeviceApprovalChallenge",
    bodyText: JSON.stringify({
      protocolVersion: 1,
      notebookId: "notebook-1",
      requestingDeviceId: "device-1",
    }),
  });
  assert.equal(activeCannotRequest.response.status, 403);

  const missingChallenge = await execute({
    path: "/activateDevice",
    bodyText: JSON.stringify({
      challengeId: "missing-challenge",
      proof: {
        protocolVersion: 1,
        approverDeviceId: "device-1",
        challengeHash: bytes(32, 1),
        signature: bytes(64, 2),
      },
    }),
  });
  assert.equal(missingChallenge.response.status, 404);

  const missingRecoveryChallenge = await execute({
    path: "/activateDeviceWithRecovery",
    bodyText: JSON.stringify({
      challengeId: "missing-challenge",
      proof: {
        protocolVersion: 1,
        recoveryKeyId: "recovery-1",
        challengeHash: bytes(32, 1),
        signature: bytes(64, 2),
      },
    }),
  });
  assert.equal(missingRecoveryChallenge.response.status, 404);
});
