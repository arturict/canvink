import * as Automerge from "@automerge/automerge";
import { Repo } from "@automerge/automerge-repo";
import { describe, expect, it, vi } from "vitest";
import {
  createDeviceIdentity,
  encryptChange,
  generateNotebookKey,
  verifyAndDecryptChange,
  type DeviceSecretIdentity,
  type NotebookEpochKey,
} from "../crypto";
import type {
  CatchUpPage,
  DevicePublicIdentity,
  HeadsAcknowledgement,
  PendingSyncEnvelope,
  SyncEnvelope,
} from "../types";
import { AutomergeDocumentBridge } from "./automerge";
import { DocHandleSyncBridge } from "./browserPorts";
import { SyncCoordinator } from "./coordinator";
import { MemoryDurableSyncState } from "./durable";
import { SyncClientError } from "./errors";
import type {
  NetworkStatePort,
  NotebookRole,
  SyncAuthPort,
  SyncCryptoPort,
  SyncRealtimePort,
  SyncTransportPort,
} from "./types";

interface TestDocument {
  [key: string]: unknown;
  items: string[];
}

class TestNetwork implements NetworkStatePort {
  private online = false;
  private readonly listeners = new Set<(online: boolean) => void>();
  isOnline = () => this.online;
  subscribe(listener: (online: boolean) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  set(online: boolean) {
    this.online = online;
    for (const listener of this.listeners) listener(online);
  }
}

class TestRealtime implements SyncRealtimePort {
  private readonly wakes = new Set<() => void>();
  notifications = true;
  async subscribe(input: { onWake: () => void }) {
    this.wakes.add(input.onWake);
    return async () => {
      this.wakes.delete(input.onWake);
    };
  }
  async publishPresence() {}
  async disconnect() {}
  wake() {
    if (this.notifications) for (const listener of this.wakes) listener();
  }
}

class FakeServer implements SyncTransportPort {
  changes: SyncEnvelope[] = [];
  loseNextAcknowledgement = false;
  reversePages = false;
  appendAttempts = 0;
  constructor(private readonly realtime: TestRealtime) {}

  async appendChange(envelope: PendingSyncEnvelope) {
    this.appendAttempts += 1;
    const existing = this.changes.find(
      (change) =>
        change.deviceId === envelope.deviceId &&
        equal(change.changeHash, envelope.changeHash),
    );
    if (existing) return { envelope: existing, duplicate: true };
    const committed: SyncEnvelope = {
      ...structuredClone(envelope),
      sequence: this.changes.length + 1,
    };
    this.changes.push(committed);
    this.realtime.wake();
    if (this.loseNextAcknowledgement) {
      this.loseNextAcknowledgement = false;
      throw new TypeError("network response was lost");
    }
    return { envelope: committed, duplicate: false };
  }

  async listChangesAfter(
    notebookId: string,
    afterSequence: number,
    limit: number,
  ): Promise<CatchUpPage> {
    const selected = this.changes
      .filter((change) => change.sequence > afterSequence)
      .slice(0, limit);
    return {
      notebookId,
      afterSequence,
      snapshotSequence: this.changes.length,
      hasMore:
        selected.at(-1)?.sequence !== this.changes.length &&
        selected.length > 0,
      envelopes: this.reversePages ? [...selected].reverse() : selected,
    };
  }

  async acknowledgeHeads(value: HeadsAcknowledgement) {
    return { accepted: value.documents.length, sequence: value.sequence };
  }
  async putKeyEnvelope() {
    return { envelopeId: "key", duplicate: false };
  }
  async uploadEncryptedAsset(): Promise<never> {
    throw new Error("not used");
  }
  async downloadEncryptedAsset(): Promise<never> {
    throw new Error("not used");
  }
  reset() {
    this.changes = [];
  }
}

class TestCrypto implements SyncCryptoPort {
  private current: number;
  private readonly keys = new Map<number, NotebookEpochKey>();
  awaited: number[] = [];
  constructor(
    private readonly notebookId: string,
    private readonly identity: DeviceSecretIdentity,
    initial: NotebookEpochKey,
    private readonly senders: ReadonlyMap<string, DevicePublicIdentity>,
  ) {
    this.current = initial.epoch;
    this.keys.set(initial.epoch, initial);
  }
  currentKeyEpoch = () => this.current;
  addFuture(key: NotebookEpochKey) {
    this.keys.set(key.epoch, key);
  }
  rotate(key: NotebookEpochKey) {
    this.keys.set(key.epoch, key);
    this.current = key.epoch;
  }
  async awaitKeyEpoch(epoch: number) {
    this.awaited.push(epoch);
    if (!this.keys.has(epoch))
      throw new SyncClientError(
        "key-epoch-unavailable",
        "Key epoch is unavailable.",
      );
    this.current = epoch;
  }
  encryptChange(documentId: string, plaintext: Uint8Array) {
    const key = this.keys.get(this.current);
    if (!key) throw new Error("missing key");
    return encryptChange({
      notebookId: this.notebookId,
      documentId,
      plaintext,
      notebookKey: key,
      sender: this.identity,
    });
  }
  async decryptChange(envelope: SyncEnvelope) {
    const key = this.keys.get(envelope.keyEpoch);
    const sender = this.senders.get(envelope.deviceId);
    if (!key || !sender) throw new Error("missing decrypt material");
    return verifyAndDecryptChange({ envelope, notebookKey: key, sender });
  }
}

function auth(role: { value: NotebookRole | null }): SyncAuthPort {
  return {
    startMicrosoftOAuth: async () => undefined,
    startEmailOtp: async () => ({ userId: "user", expire: "later" }),
    completeEmailOtp: async () => ({ userId: "user", name: "User" }),
    currentAccount: async () => ({ userId: "user", name: "User" }),
    logout: async () => undefined,
    roleForNotebook: async () => role.value,
  };
}

async function device(accountId: string, deviceId: string, fill: number) {
  return createDeviceIdentity({
    accountId,
    deviceId,
    encryptionSeed: new Uint8Array(32).fill(fill),
    signingSeed: new Uint8Array(32).fill(fill + 20),
  });
}

describe("durable encrypted sync coordinator", () => {
  it("converges five real Repo handles through disconnect, coordinator reinstall, and server reset recovery", async () => {
    const notebookId = "five-client-notebook";
    const clientCount = 5;
    const identities = await Promise.all(
      Array.from({ length: clientCount }, (_, index) =>
        device(`account-${index}`, `device-${index}`, index + 30),
      ),
    );
    const senders = new Map(
      identities.map((identity) => [
        identity.publicIdentity.deviceId,
        identity.publicIdentity,
      ]),
    );
    const key = await generateNotebookKey(notebookId, 1);
    const realtime = new TestRealtime();
    realtime.notifications = false;
    const server = new FakeServer(realtime);
    const initialBinary = Automerge.save(
      Automerge.from<TestDocument>({ items: [] }),
    );
    let operation = 0;

    // automerge-repo 2.5.6's internal asyncThrottle can calculate a
    // slightly negative wait when parallel tests delay its first callback.
    // Clamp at the test timer boundary while retaining real asynchronous time.
    const nativeSetTimeout = globalThis.setTimeout;
    const timeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((handler, timeout, ...arguments_) =>
        nativeSetTimeout(handler, Math.max(0, timeout ?? 0), ...arguments_),
      );

    const clients = identities.map((identity) => {
      const repo = new Repo({ network: [] });
      const handle = repo.import<TestDocument>(initialBinary);
      const bridge = new DocHandleSyncBridge();
      const network = new TestNetwork();
      const durable = new MemoryDurableSyncState();
      const crypto = new TestCrypto(notebookId, identity, key, senders);
      const role = { value: "editor" as NotebookRole | null };
      const queued: Promise<void>[] = [];
      const makeCoordinator = () =>
        new SyncCoordinator({
          notebookId,
          deviceId: identity.publicIdentity.deviceId,
          auth: auth(role),
          transport: server,
          realtime,
          durable,
          crypto,
          documents: bridge,
          network,
          backoff: { wait: async () => undefined },
          createOperationId: () => `five-client-${++operation}`,
        });
      const state = {
        repo,
        handle,
        bridge,
        network,
        durable,
        crypto,
        role,
        queued,
        coordinator: makeCoordinator(),
        makeCoordinator,
      };
      bridge.register<TestDocument>(
        "document",
        handle,
        (_documentId, change) => {
          const pending = state.coordinator.enqueueLocalChange(
            "document",
            change,
          );
          state.queued.push(pending);
          return pending;
        },
      );
      return state;
    });

    try {
      await Promise.all(clients.map((client) => client.coordinator.start()));
      for (const [index, client] of clients.entries()) {
        client.handle.change((document) => {
          document.items.push(`offline-${index}`);
        });
      }
      await Promise.all(clients.flatMap((client) => client.queued.splice(0)));
      expect(server.changes).toHaveLength(0);

      for (const client of clients.slice(0, 3)) client.network.set(true);
      await syncRounds(clients.slice(0, 3), 2);
      for (const client of clients.slice(3)) client.network.set(true);
      await syncRounds(clients, 3);
      expectRepoClientsConverged(
        clients.map((client) => client.handle.doc()),
        5,
      );

      const reconnecting = clients[2];
      reconnecting.network.set(false);
      reconnecting.handle.change((document) => {
        document.items.push("reconnected");
      });
      await Promise.all(reconnecting.queued.splice(0));
      await syncRounds(
        clients.filter((client) => client !== reconnecting),
        1,
      );
      reconnecting.network.set(true);
      await syncRounds(clients, 3);
      expectRepoClientsConverged(
        clients.map((client) => client.handle.doc()),
        6,
      );

      const reinstalled = clients[4];
      await reinstalled.coordinator.stop();
      reinstalled.coordinator = reinstalled.makeCoordinator();
      await reinstalled.coordinator.start();
      await syncRounds(clients, 2);
      expectRepoClientsConverged(
        clients.map((client) => client.handle.doc()),
        6,
      );

      server.reset();
      await clients[0].coordinator.syncNow();
      await syncRounds(clients.slice(1), 2);
      expect(server.changes.length).toBeGreaterThanOrEqual(6);
      expect(
        clients.every(
          (client) => client.coordinator.cursor === server.changes.length,
        ),
      ).toBe(true);
      expectRepoClientsConverged(
        clients.map((client) => client.handle.doc()),
        6,
      );
    } finally {
      await Promise.all(clients.map((client) => client.coordinator.stop()));
      await Promise.all(clients.map((client) => client.repo.shutdown()));
      timeoutSpy.mockRestore();
    }
  });

  it("converges two real Automerge docs after simultaneous offline edits, lost ack, reordering, missed Realtime, and key rotation", async () => {
    const notebookId = "notebook";
    const firstIdentity = await device("first-account", "first-device", 1);
    const secondIdentity = await device("second-account", "second-device", 2);
    const senders = new Map([
      [firstIdentity.publicIdentity.deviceId, firstIdentity.publicIdentity],
      [secondIdentity.publicIdentity.deviceId, secondIdentity.publicIdentity],
    ]);
    const epoch1 = await generateNotebookKey(notebookId, 1);
    const epoch2 = await generateNotebookKey(notebookId, 2);
    const firstCrypto = new TestCrypto(
      notebookId,
      firstIdentity,
      epoch1,
      senders,
    );
    const secondCrypto = new TestCrypto(
      notebookId,
      secondIdentity,
      epoch1,
      senders,
    );
    firstCrypto.addFuture(epoch2);
    secondCrypto.addFuture(epoch2);

    const base = Automerge.from<TestDocument>({ items: [] });
    let firstDoc = Automerge.clone(base);
    let secondDoc = Automerge.clone(base);
    const firstBridge = new AutomergeDocumentBridge();
    const secondBridge = new AutomergeDocumentBridge();
    firstBridge.register<TestDocument>("document", firstDoc, (value) => {
      firstDoc = value;
    });
    secondBridge.register<TestDocument>("document", secondDoc, (value) => {
      secondDoc = value;
    });
    const realtime = new TestRealtime();
    const server = new FakeServer(realtime);
    server.loseNextAcknowledgement = true;
    server.reversePages = true;
    const firstNetwork = new TestNetwork();
    const secondNetwork = new TestNetwork();
    const firstRole = { value: "editor" as NotebookRole | null };
    const secondRole = { value: "editor" as NotebookRole | null };
    let operation = 0;
    const coordinator = (
      deviceId: string,
      crypto: SyncCryptoPort,
      documents: AutomergeDocumentBridge,
      network: TestNetwork,
      role: { value: NotebookRole | null },
    ) =>
      new SyncCoordinator({
        notebookId,
        deviceId,
        auth: auth(role),
        transport: server,
        realtime,
        durable: new MemoryDurableSyncState(),
        crypto,
        documents,
        network,
        backoff: { wait: async () => undefined },
        createOperationId: () => `operation-${++operation}`,
      });
    const first = coordinator(
      "first-device",
      firstCrypto,
      firstBridge,
      firstNetwork,
      firstRole,
    );
    const second = coordinator(
      "second-device",
      secondCrypto,
      secondBridge,
      secondNetwork,
      secondRole,
    );
    await Promise.all([first.start(), second.start()]);

    const firstBefore = firstDoc;
    firstDoc = Automerge.change(firstDoc, (doc) => {
      doc.items.push("first");
    });
    firstBridge.replace("document", firstDoc);
    for (const change of firstBridge.extractLocalChanges(
      "document",
      firstBefore,
      firstDoc,
    ))
      await first.enqueueLocalChange("document", change);
    const secondBefore = secondDoc;
    secondDoc = Automerge.change(secondDoc, (doc) => {
      doc.items.push("second");
    });
    secondBridge.replace("document", secondDoc);
    for (const change of secondBridge.extractLocalChanges(
      "document",
      secondBefore,
      secondDoc,
    ))
      await second.enqueueLocalChange("document", change);
    expect(server.changes).toHaveLength(0);

    realtime.notifications = false;
    firstNetwork.set(true);
    secondNetwork.set(true);
    await Promise.all([first.syncNow(), second.syncNow()]);
    await Promise.all([first.syncNow(), second.syncNow()]);
    expect([...firstDoc.items].sort()).toEqual(["first", "second"]);
    expect([...secondDoc.items].sort()).toEqual(["first", "second"]);
    expect(first.pendingCount + second.pendingCount).toBe(0);
    expect(server.appendAttempts).toBeGreaterThan(2);

    secondCrypto.rotate(epoch2);
    const beforeRotation = secondDoc;
    secondDoc = Automerge.change(secondDoc, (doc) => {
      doc.items.push("rotated");
    });
    secondBridge.replace("document", secondDoc);
    for (const change of secondBridge.extractLocalChanges(
      "document",
      beforeRotation,
      secondDoc,
    ))
      await second.enqueueLocalChange("document", change);
    await second.syncNow();
    await first.syncNow();
    expect(firstCrypto.awaited).toContain(2);
    expect(firstDoc.items).toContain("rotated");
  });

  it("fails closed for viewers/removals and repopulates a reset server from local Automerge authority", async () => {
    const identity = await device("account", "device", 5);
    const key = await generateNotebookKey("notebook", 1);
    const crypto = new TestCrypto(
      "notebook",
      identity,
      key,
      new Map([[identity.publicIdentity.deviceId, identity.publicIdentity]]),
    );
    let document = Automerge.from<TestDocument>({ items: [] });
    const bridge = new AutomergeDocumentBridge();
    bridge.register<TestDocument>("document", document, (value) => {
      document = value;
    });
    const realtime = new TestRealtime();
    const server = new FakeServer(realtime);
    const network = new TestNetwork();
    network.set(true);
    const role = { value: "editor" as NotebookRole | null };
    let operation = 0;
    const coordinator = new SyncCoordinator({
      notebookId: "notebook",
      deviceId: "device",
      auth: auth(role),
      transport: server,
      realtime,
      durable: new MemoryDurableSyncState(),
      crypto,
      documents: bridge,
      network,
      backoff: { wait: async () => undefined },
      createOperationId: () => `reset-${++operation}`,
    });
    await coordinator.start();
    const before = document;
    document = Automerge.change(document, (doc) => {
      doc.items.push("authority");
    });
    bridge.replace("document", document);
    for (const change of bridge.extractLocalChanges(
      "document",
      before,
      document,
    ))
      await coordinator.enqueueLocalChange("document", change);
    await coordinator.syncNow();
    expect(coordinator.cursor).toBe(1);
    server.reset();
    await coordinator.syncNow();
    expect(server.changes.length).toBeGreaterThanOrEqual(2);
    expect(coordinator.cursor).toBe(server.changes.length);

    role.value = "viewer";
    await coordinator.syncNow();
    await expect(
      coordinator.enqueueLocalChange("document", new Uint8Array([1])),
    ).rejects.toMatchObject({ code: "viewer-read-only" });
    role.value = null;
    await expect(coordinator.syncNow()).rejects.toMatchObject({
      code: "removed-member",
    });
    expect(coordinator.status).toBe("removed");
  });
});

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length &&
    left.every((byte, index) => byte === right[index])
  );
}

async function syncRounds(
  clients: ReadonlyArray<{ coordinator: SyncCoordinator }>,
  rounds: number,
): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await Promise.all(clients.map((client) => client.coordinator.syncNow()));
  }
}

function expectRepoClientsConverged(
  documents: readonly Automerge.Doc<TestDocument>[],
  expectedItems: number,
): void {
  const canonicalItems = JSON.stringify([...documents[0].items].sort());
  const canonicalHeads = JSON.stringify(
    Automerge.getHeads(documents[0]).slice().sort(),
  );
  for (const document of documents) {
    expect(document.items).toHaveLength(expectedItems);
    expect(JSON.stringify([...document.items].sort())).toBe(canonicalItems);
    expect(JSON.stringify(Automerge.getHeads(document).slice().sort())).toBe(
      canonicalHeads,
    );
  }
}
