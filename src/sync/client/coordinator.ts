import {
  commitAppliedEnvelopes,
  createInboundSyncState,
  getReadyEnvelopes,
  ingestSyncEnvelope,
} from "../inbox";
import {
  acknowledgeOutbox,
  createOutboxState,
  enqueueOutbox,
  selectOutboxBatch,
} from "../outbox";
import {
  SYNC_PROTOCOL_VERSION,
  type InboundSyncState,
  type OutboxState,
  type PendingSyncEnvelope,
  type SyncEnvelope,
} from "../types";
import { bytesToHex } from "../validation";
import { SyncClientError, toSyncClientError } from "./errors";
import type {
  BackoffPort,
  DurableSyncSnapshot,
  DurableSyncStatePort,
  NetworkStatePort,
  NotebookPresence,
  NotebookRole,
  SyncAccount,
  SyncAuthPort,
  SyncCryptoPort,
  SyncDocumentPort,
  SyncRealtimePort,
  SyncTransportPort,
} from "./types";

export interface SyncCoordinatorOptions {
  notebookId: string;
  deviceId: string;
  auth: SyncAuthPort;
  transport: SyncTransportPort;
  realtime: SyncRealtimePort;
  durable: DurableSyncStatePort;
  crypto: SyncCryptoPort;
  documents: SyncDocumentPort;
  network: NetworkStatePort;
  backoff?: BackoffPort;
  createOperationId?: () => string;
  onPresence?: (presence: NotebookPresence) => void;
  onError?: (error: SyncClientError) => void;
}

export type SyncCoordinatorStatus =
  | "stopped"
  | "starting"
  | "idle"
  | "syncing"
  | "removed";

export class SyncCoordinator {
  private statusValue: SyncCoordinatorStatus = "stopped";
  private account: SyncAccount | null = null;
  private roleValue: NotebookRole | null = null;
  private outbox: OutboxState = createOutboxState();
  private inbox: InboundSyncState;
  private readonly controller = new AbortController();
  private unsubscribeNetwork?: () => void;
  private unsubscribeRealtime?: () => Promise<void>;
  private activeSync?: Promise<void>;
  private wakeRequested = false;
  private operationSequence = 0;
  private readonly backoff: BackoffPort;

  constructor(private readonly options: SyncCoordinatorOptions) {
    this.inbox = createInboundSyncState(options.notebookId);
    this.backoff = options.backoff ?? { wait: abortableWait };
  }

  get status(): SyncCoordinatorStatus {
    return this.statusValue;
  }
  get role(): NotebookRole | null {
    return this.roleValue;
  }
  get cursor(): number {
    return this.inbox.contiguousSequence;
  }
  get pendingCount(): number {
    return this.outbox.pending.length;
  }

  async start(): Promise<void> {
    if (this.statusValue !== "stopped") return;
    this.statusValue = "starting";
    this.account = await this.options.auth.currentAccount();
    if (!this.account) {
      this.statusValue = "stopped";
      throw new SyncClientError(
        "authentication-required",
        "Sign in to enable sync.",
      );
    }
    await this.refreshRole();
    const stored = await this.options.durable.load(this.options.notebookId);
    if (stored) this.restore(stored);
    this.unsubscribeNetwork = this.options.network.subscribe((online) => {
      if (online) this.wake();
    });
    this.unsubscribeRealtime = await this.options.realtime.subscribe({
      notebookId: this.options.notebookId,
      onWake: () => this.wake(),
      onPresence: (presence) => this.options.onPresence?.(presence),
    });
    this.statusValue = "idle";
    if (this.options.network.isOnline()) this.wake();
  }

  async stop(): Promise<void> {
    if (this.statusValue === "stopped") return;
    this.controller.abort();
    this.unsubscribeNetwork?.();
    await this.unsubscribeRealtime?.().catch(() => undefined);
    await this.options.realtime.disconnect().catch(() => undefined);
    this.statusValue = "stopped";
  }

  async enqueueLocalChange(
    documentId: string,
    change: Uint8Array,
  ): Promise<void> {
    this.assertWritable();
    const envelope = await this.options.crypto.encryptChange(
      documentId,
      change.slice(),
    );
    if (envelope.keyEpoch !== this.options.crypto.currentKeyEpoch()) {
      throw new SyncClientError(
        "key-epoch-unavailable",
        "The current notebook key changed during encryption.",
      );
    }
    this.outbox = enqueueOutbox(this.outbox, this.nextOperationId(), envelope);
    await this.persist();
    this.wake();
  }

  async publishPresence(
    input: Omit<NotebookPresence, "notebookId" | "deviceId">,
  ): Promise<void> {
    if (!this.account || this.statusValue === "removed") return;
    await this.options.realtime.publishPresence({
      ...input,
      notebookId: this.options.notebookId,
      deviceId: this.options.deviceId,
    });
  }

  async putKeyEnvelope(
    value: Parameters<SyncTransportPort["putKeyEnvelope"]>[0],
  ): Promise<void> {
    if (this.roleValue !== "owner")
      throw new SyncClientError(
        "forbidden",
        "Only the notebook owner can rotate keys.",
      );
    await this.retry(() =>
      this.options.transport.putKeyEnvelope(value, this.controller.signal),
    );
  }

  async uploadEncryptedAsset(
    value: Parameters<SyncTransportPort["uploadEncryptedAsset"]>[0],
  ) {
    this.assertWritable();
    return this.retry(() =>
      this.options.transport.uploadEncryptedAsset(
        value,
        this.controller.signal,
      ),
    );
  }

  async syncNow(): Promise<void> {
    if (!this.options.network.isOnline())
      throw new SyncClientError(
        "offline",
        "Sync will resume when the device is online.",
      );
    if (this.activeSync) return this.activeSync;
    this.activeSync = this.performSync().finally(() => {
      this.activeSync = undefined;
    });
    return this.activeSync;
  }

  private wake(): void {
    if (this.statusValue === "stopped" || this.statusValue === "removed")
      return;
    if (this.activeSync) {
      this.wakeRequested = true;
      return;
    }
    void this.syncNow().catch((error) =>
      this.options.onError?.(toSyncClientError(error)),
    );
  }

  private async performSync(): Promise<void> {
    this.statusValue = "syncing";
    try {
      do {
        this.wakeRequested = false;
        await this.refreshRole();
        await this.flushOutbox();
        await this.catchUp();
      } while (this.wakeRequested && !this.controller.signal.aborted);
    } finally {
      if (this.statusValue === "syncing") this.statusValue = "idle";
    }
  }

  private async refreshRole(): Promise<void> {
    if (!this.account)
      throw new SyncClientError(
        "authentication-required",
        "Sign in to continue syncing.",
      );
    const role = await this.options.auth.roleForNotebook(
      this.options.notebookId,
      this.account.userId,
    );
    if (!role) {
      this.statusValue = "removed";
      this.roleValue = null;
      this.controller.abort();
      await this.unsubscribeRealtime?.().catch(() => undefined);
      throw new SyncClientError(
        "removed-member",
        "This account is no longer a notebook member.",
      );
    }
    this.roleValue = role;
  }

  private async flushOutbox(): Promise<void> {
    if (this.roleValue === "viewer" && this.outbox.pending.length > 0) {
      throw new SyncClientError(
        "viewer-read-only",
        "Viewers cannot upload notebook changes.",
      );
    }
    for (const entry of selectOutboxBatch(
      this.outbox,
      this.outbox.pending.length || 1,
    )) {
      const result = await this.retry(() =>
        this.options.transport.appendChange(
          entry.envelope,
          this.controller.signal,
        ),
      );
      this.outbox = acknowledgeOutbox(this.outbox, [
        { operationId: entry.operationId, envelope: result.envelope },
      ]);
      await this.persist();
    }
  }

  private async catchUp(): Promise<void> {
    let resetRecoveryAttempted = false;
    while (!this.controller.signal.aborted) {
      const page = await this.retry(() =>
        this.options.transport.listChangesAfter(
          this.options.notebookId,
          this.inbox.contiguousSequence,
          100,
          this.controller.signal,
        ),
      );
      if (page.snapshotSequence < this.inbox.contiguousSequence) {
        await this.rebuildAfterServerReset();
        await this.flushOutbox();
        resetRecoveryAttempted = true;
        continue;
      }
      let next = this.inbox;
      let restartFromServerOrigin = false;
      for (const envelope of page.envelopes) {
        const ingested = ingestSyncEnvelope(next, envelope);
        if (!ingested.accepted) {
          if (ingested.reason === "duplicate") continue;
          if (
            ingested.reason === "replay" &&
            envelope.sequence > next.contiguousSequence &&
            !resetRecoveryAttempted
          ) {
            // A reset stream can be repopulated beyond this client's old cursor
            // before it reconnects. The new sequence is unsigned, so never
            // accept it as a new change. Drop only stale cursor receipts and
            // authenticate the replacement stream again from sequence zero.
            this.inbox = createInboundSyncState(this.options.notebookId);
            await this.persist();
            resetRecoveryAttempted = true;
            restartFromServerOrigin = true;
            break;
          }
          throw new SyncClientError(
            "protocol-error",
            "Catch-up sequence integrity failed.",
          );
        }
        next = ingested.state;
      }
      if (restartFromServerOrigin) continue;
      const ready = getReadyEnvelopes(next);
      for (const envelope of ready) await this.applyEnvelope(envelope);
      next = commitAppliedEnvelopes(next, ready);
      this.inbox = next;
      await this.persist();
      if (!page.hasMore) {
        if (this.inbox.contiguousSequence !== page.snapshotSequence) {
          throw new SyncClientError(
            "protocol-error",
            "Catch-up did not reach its stable snapshot.",
          );
        }
        await this.acknowledgeHeads();
        return;
      }
    }
  }

  private async applyEnvelope(envelope: SyncEnvelope): Promise<void> {
    if (envelope.keyEpoch > this.options.crypto.currentKeyEpoch()) {
      await this.options.crypto.awaitKeyEpoch(
        envelope.keyEpoch,
        this.controller.signal,
      );
    }
    const plaintext = await this.options.crypto.decryptChange(envelope);
    await this.options.documents.applyRemoteChange(
      envelope.documentId,
      plaintext,
    );
  }

  private async acknowledgeHeads(): Promise<void> {
    const documents = await this.options.documents.heads();
    await this.retry(() =>
      this.options.transport.acknowledgeHeads(
        {
          protocolVersion: SYNC_PROTOCOL_VERSION,
          notebookId: this.options.notebookId,
          deviceId: this.options.deviceId,
          sequence: this.inbox.contiguousSequence,
          documents,
        },
        this.controller.signal,
      ),
    );
  }

  private async rebuildAfterServerReset(): Promise<void> {
    const known = new Map<string, PendingSyncEnvelope>();
    for (const entry of this.outbox.pending)
      known.set(changeIdentity(entry.envelope), entry.envelope);
    for (const receipt of this.outbox.acknowledged) {
      known.set(changeIdentity(receipt.envelope), {
        ...receipt.envelope,
        sequence: null,
      });
    }
    const rebuilt = createOutboxState();
    let next = rebuilt;
    for (const {
      documentId,
      change,
    } of await this.options.documents.allChanges()) {
      const encrypted = await this.options.crypto.encryptChange(
        documentId,
        change,
      );
      const envelope = known.get(changeIdentity(encrypted)) ?? encrypted;
      next = enqueueOutbox(next, this.nextOperationId(), envelope);
    }
    this.outbox = next;
    this.inbox = createInboundSyncState(this.options.notebookId);
    await this.persist();
  }

  private async retry<T>(operation: () => Promise<T>): Promise<T> {
    let delay = 200;
    for (let attempt = 0; ; attempt += 1) {
      if (this.controller.signal.aborted)
        throw new SyncClientError("aborted", "Sync was cancelled.");
      if (!this.options.network.isOnline())
        throw new SyncClientError(
          "offline",
          "Sync will resume when the device is online.",
        );
      try {
        return await operation();
      } catch (error) {
        const safe = toSyncClientError(error);
        if (safe.code === "forbidden") await this.refreshRole();
        if (
          !["service-unavailable", "rate-limited"].includes(safe.code) ||
          attempt >= 5
        )
          throw safe;
        await this.backoff.wait(delay, this.controller.signal);
        delay = Math.min(delay * 2, 5_000);
      }
    }
  }

  private assertWritable(): void {
    if (!this.account)
      throw new SyncClientError(
        "authentication-required",
        "Sign in to edit a synced notebook.",
      );
    if (this.statusValue === "removed")
      throw new SyncClientError(
        "removed-member",
        "This account is no longer a notebook member.",
      );
    if (this.roleValue === "viewer")
      throw new SyncClientError(
        "viewer-read-only",
        "Viewers cannot change a synced notebook.",
      );
    if (!this.roleValue)
      throw new SyncClientError(
        "forbidden",
        "Notebook membership is unavailable.",
      );
  }

  private restore(snapshot: DurableSyncSnapshot): void {
    if (
      snapshot.version !== 1 ||
      snapshot.notebookId !== this.options.notebookId ||
      snapshot.inbox.notebookId !== snapshot.notebookId
    ) {
      throw new SyncClientError(
        "protocol-error",
        "Durable sync state is invalid.",
      );
    }
    this.outbox = structuredClone(snapshot.outbox);
    this.inbox = structuredClone(snapshot.inbox);
  }

  private persist(): Promise<void> {
    return this.options.durable.save({
      version: 1,
      notebookId: this.options.notebookId,
      outbox: this.outbox,
      inbox: this.inbox,
    });
  }

  private nextOperationId(): string {
    return (
      this.options.createOperationId?.() ??
      `${this.options.deviceId}.${Date.now().toString(36)}.${(++this.operationSequence).toString(36)}`
    );
  }
}

function changeIdentity(
  envelope: Pick<PendingSyncEnvelope, "documentId" | "changeHash">,
): string {
  return `${envelope.documentId}:${bytesToHex(envelope.changeHash)}`;
}

function abortableWait(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}
