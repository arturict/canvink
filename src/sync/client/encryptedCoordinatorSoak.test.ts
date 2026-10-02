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

interface SoakDocument {
  [key: string]: unknown;
  entries: Record<string, number>;
}

interface EncryptedCoordinatorEvidence {
  version: 1;
  layer: "encrypted-coordinator";
  startedAt: string;
  endedAt: string;
  requestedMinutes: number;
  durationMs: number;
  clients: 5;
  iterations: number;
  edits: number;
  convergenceChecks: number;
  disconnects: number;
  reconnects: number;
  coordinatorRestarts: number;
  serverResets: number;
  lostAcknowledgements: number;
  appendAttempts: number;
  unexpectedErrors: number;
  converged: true;
}

class SoakNetwork implements NetworkStatePort {
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

class SoakRealtime implements SyncRealtimePort {
  async subscribe() {
    return async () => undefined;
  }
  async publishPresence() {}
  async disconnect() {}
}

class SoakServer implements SyncTransportPort {
  changes: SyncEnvelope[] = [];
  appendAttempts = 0;
  loseNextAcknowledgement = false;
  lostAcknowledgements = 0;

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
    if (this.loseNextAcknowledgement) {
      this.loseNextAcknowledgement = false;
      this.lostAcknowledgements += 1;
      throw new TypeError("simulated lost acknowledgement");
    }
    return { envelope: committed, duplicate: false };
  }

  async listChangesAfter(
    notebookId: string,
    afterSequence: number,
    limit: number,
  ): Promise<CatchUpPage> {
    const envelopes = this.changes
      .filter((change) => change.sequence > afterSequence)
      .slice(0, limit);
    return {
      notebookId,
      afterSequence,
      snapshotSequence: this.changes.length,
      hasMore:
        envelopes.length > 0 &&
        envelopes.at(-1)?.sequence !== this.changes.length,
      envelopes,
    };
  }

  async acknowledgeHeads(value: HeadsAcknowledgement) {
    return { accepted: value.documents.length, sequence: value.sequence };
  }
  async putKeyEnvelope() {
    return { envelopeId: "unused", duplicate: false };
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

class SoakCrypto implements SyncCryptoPort {
  constructor(
    private readonly notebookId: string,
    private readonly identity: DeviceSecretIdentity,
    private readonly key: NotebookEpochKey,
    private readonly senders: ReadonlyMap<string, DevicePublicIdentity>,
  ) {}
  currentKeyEpoch = () => this.key.epoch;
  async awaitKeyEpoch(epoch: number) {
    if (epoch !== this.key.epoch)
      throw new SyncClientError(
        "key-epoch-unavailable",
        "Unexpected soak key epoch.",
      );
  }
  encryptChange(documentId: string, plaintext: Uint8Array) {
    return encryptChange({
      notebookId: this.notebookId,
      documentId,
      plaintext,
      notebookKey: this.key,
      sender: this.identity,
    });
  }
  async decryptChange(envelope: SyncEnvelope) {
    const sender = this.senders.get(envelope.deviceId);
    if (!sender) throw new Error("Unknown soak sender.");
    return verifyAndDecryptChange({
      envelope,
      notebookKey: this.key,
      sender,
    });
  }
}

function auth(): SyncAuthPort {
  return {
    startMicrosoftOAuth: async () => undefined,
    startEmailOtp: async () => ({ userId: "user", expire: "later" }),
    completeEmailOtp: async () => ({ userId: "user", name: "User" }),
    currentAccount: async () => ({ userId: "user", name: "User" }),
    logout: async () => undefined,
    roleForNotebook: async () => "editor" as NotebookRole,
  };
}

const testProcess = (
  globalThis as {
    process?: {
      env?: Record<string, string | undefined>;
      stdout?: { write(value: string): void };
    };
  }
).process;
const soakMinutes = Number(testProcess?.env?.CANVINK_SYNC_SOAK_MINUTES ?? 0);

describe.skipIf(!(soakMinutes > 0))(
  "encrypted five-client coordinator soak",
  () => {
    it(
      `keeps five full clients converged for ${soakMinutes} minute(s); production gate is 60`,
      async () => {
        const notebookId = "encrypted-soak-notebook";
        const clientCount = 5 as const;
        const started = Date.now();
        const deadline = started + soakMinutes * 60_000;
        const initialBinary = Automerge.save(
          Automerge.from<SoakDocument>({ entries: {} }),
        );
        const identities = await Promise.all(
          Array.from({ length: clientCount }, (_, index) =>
            createDeviceIdentity({
              accountId: `soak-account-${index}`,
              deviceId: `soak-device-${index}`,
              encryptionSeed: new Uint8Array(32).fill(index + 1),
              signingSeed: new Uint8Array(32).fill(index + 21),
            }),
          ),
        );
        const senders = new Map(
          identities.map((identity) => [
            identity.publicIdentity.deviceId,
            identity.publicIdentity,
          ]),
        );
        const key = await generateNotebookKey(notebookId, 1);
        const realtime = new SoakRealtime();
        const server = new SoakServer();
        const fastLocalSmoke = soakMinutes < 1;
        const iterationPauseMs = fastLocalSmoke ? 100 : 4_000;
        const restartEvery = fastLocalSmoke ? 3 : 15;
        const resetEvery = fastLocalSmoke ? 5 : 150;
        let operation = 0;
        let unexpectedErrors = 0;

        const nativeSetTimeout = globalThis.setTimeout;
        const timeoutSpy = vi
          .spyOn(globalThis, "setTimeout")
          .mockImplementation((handler, timeout, ...arguments_) =>
            nativeSetTimeout(handler, Math.max(0, timeout ?? 0), ...arguments_),
          );

        const clients = identities.map((identity) => {
          const repo = new Repo({ network: [] });
          const handle = repo.import<SoakDocument>(initialBinary);
          const bridge = new DocHandleSyncBridge();
          const network = new SoakNetwork();
          const durable = new MemoryDurableSyncState();
          const crypto = new SoakCrypto(notebookId, identity, key, senders);
          const queued: Promise<void>[] = [];
          const makeCoordinator = () =>
            new SyncCoordinator({
              notebookId,
              deviceId: identity.publicIdentity.deviceId,
              auth: auth(),
              transport: server,
              realtime,
              durable,
              crypto,
              documents: bridge,
              network,
              backoff: { wait: async () => undefined },
              createOperationId: () => `soak-operation-${++operation}`,
              onError: (error) => {
                if (error.code !== "offline") unexpectedErrors += 1;
              },
            });
          const state = {
            repo,
            handle,
            bridge,
            network,
            durable,
            crypto,
            queued,
            coordinator: undefined as unknown as SyncCoordinator,
            makeCoordinator,
          };
          state.coordinator = makeCoordinator();
          bridge.register<SoakDocument>(
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

        let iterations = 0;
        let edits = 0;
        let convergenceChecks = 0;
        let disconnects = 0;
        let reconnects = 0;
        let coordinatorRestarts = 0;
        let serverResets = 0;
        let nextProgressAt = started;

        try {
          await Promise.all(
            clients.map((client) => client.coordinator.start()),
          );
          for (const client of clients) client.network.set(true);
          await syncRounds(clients, 1);

          while (Date.now() < deadline || iterations === 0) {
            const editor = clients[iterations % clientCount];
            const disconnect = iterations % 5 === 0;
            if (disconnect) {
              editor.network.set(false);
              disconnects += 1;
            }
            if (iterations % 10 === 0) server.loseNextAcknowledgement = true;

            editor.handle.change((document) => {
              document.entries[`edit-${edits}`] = edits;
            });
            edits += 1;
            await Promise.all(editor.queued.splice(0));
            await syncRounds(
              clients.filter((client) => client.network.isOnline()),
              1,
            );
            if (disconnect) {
              editor.network.set(true);
              reconnects += 1;
            }
            await syncRounds(clients, 2);

            if (iterations > 0 && iterations % restartEvery === 0) {
              const restarting =
                clients[(iterations / restartEvery) % clientCount];
              await restarting.coordinator.stop();
              restarting.coordinator = restarting.makeCoordinator();
              await restarting.coordinator.start();
              coordinatorRestarts += 1;
              await syncRounds(clients, 1);
            }

            if (iterations > 0 && iterations % resetEvery === 0) {
              server.reset();
              await clients[0].coordinator.syncNow();
              await syncRounds(clients.slice(1), 2);
              serverResets += 1;
            }

            assertConverged(
              clients.map((client) => client.handle.doc()),
              edits,
            );
            convergenceChecks += 1;
            iterations += 1;

            const observed = Date.now();
            if (observed >= nextProgressAt) {
              emit("PROGRESS", {
                version: 1,
                layer: "encrypted-coordinator",
                startedAt: new Date(started).toISOString(),
                observedAt: new Date(observed).toISOString(),
                requestedMinutes: soakMinutes,
                elapsedMs: observed - started,
                clients: clientCount,
                iterations,
                edits,
                convergenceChecks,
                disconnects,
                reconnects,
                coordinatorRestarts,
                serverResets,
                lostAcknowledgements: server.lostAcknowledgements,
                appendAttempts: server.appendAttempts,
                unexpectedErrors,
              });
              nextProgressAt = observed + 60_000;
            }

            const remainingMs = deadline - Date.now();
            if (remainingMs > 0)
              await delay(Math.min(iterationPauseMs, remainingMs));
          }

          const ended = Date.now();
          const evidence: EncryptedCoordinatorEvidence = {
            version: 1,
            layer: "encrypted-coordinator",
            startedAt: new Date(started).toISOString(),
            endedAt: new Date(ended).toISOString(),
            requestedMinutes: soakMinutes,
            durationMs: ended - started,
            clients: clientCount,
            iterations,
            edits,
            convergenceChecks,
            disconnects,
            reconnects,
            coordinatorRestarts,
            serverResets,
            lostAcknowledgements: server.lostAcknowledgements,
            appendAttempts: server.appendAttempts,
            unexpectedErrors,
            converged: true,
          };
          emit("EVIDENCE", evidence);
          expect(evidence.durationMs).toBeGreaterThanOrEqual(
            soakMinutes * 60_000,
          );
          expect(evidence.disconnects).toBe(evidence.reconnects);
          expect(evidence.unexpectedErrors).toBe(0);
        } finally {
          await Promise.all(clients.map((client) => client.coordinator.stop()));
          await Promise.all(clients.map((client) => client.repo.shutdown()));
          timeoutSpy.mockRestore();
        }
      },
      Math.max(10_000, soakMinutes * 60_000 + 60_000),
    );
  },
);

async function syncRounds(
  clients: ReadonlyArray<{ coordinator: SyncCoordinator }>,
  rounds: number,
): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await Promise.all(clients.map((client) => client.coordinator.syncNow()));
  }
}

function assertConverged(
  documents: readonly Automerge.Doc<SoakDocument>[],
  expectedEdits: number,
): void {
  const entries = JSON.stringify(
    Object.entries(documents[0].entries).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  const heads = JSON.stringify(Automerge.getHeads(documents[0]).slice().sort());
  for (const document of documents) {
    if (Object.keys(document.entries).length !== expectedEdits)
      throw new Error("An encrypted soak client lost edits.");
    if (
      JSON.stringify(
        Object.entries(document.entries).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ) !== entries
    )
      throw new Error("Encrypted soak clients diverged in content.");
    if (JSON.stringify(Automerge.getHeads(document).slice().sort()) !== heads)
      throw new Error("Encrypted soak clients diverged in heads.");
  }
}

function emit(kind: "PROGRESS" | "EVIDENCE", value: unknown): void {
  testProcess?.stdout?.write(
    `CANVINK_SYNC_SOAK_${kind} ${JSON.stringify(value)}\n`,
  );
}

async function delay(milliseconds: number): Promise<void> {
  const safe = Math.max(0, Math.ceil(milliseconds));
  await new Promise<void>((resolve) => setTimeout(resolve, safe));
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length &&
    left.every((byte, index) => byte === right[index])
  );
}
