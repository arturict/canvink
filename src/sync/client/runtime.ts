import type { DocHandle } from "@automerge/automerge-repo";
import type { DeviceSecretIdentity, NotebookEpochKey } from "../crypto";
import type { DevicePublicIdentity } from "../types";
import { DocHandleSyncBridge, type SyncWorkspaceDocumentsPort } from "./browserPorts";
import { SyncCoordinator } from "./coordinator";
import { NotebookCryptoAdapter } from "./cryptoAdapter";
import { BrowserNetworkState } from "./durable";
import type { AppwriteSyncServices } from "./appwrite";
import type {
  DurableSyncStatePort,
  NetworkStatePort,
  NotebookPresence,
  SyncDeviceDirectoryPort,
} from "./types";
import { SyncClientError } from "./errors";
import type { NotebookKeyringPort } from "./keyringPersistence";

export interface NotebookSyncRuntimeOptions {
  notebookId: string;
  identity: DeviceSecretIdentity;
  keyring: NotebookKeyringPort;
  services: AppwriteSyncServices;
  durable: DurableSyncStatePort;
  network?: NetworkStatePort;
  resolveSender(deviceId: string): Promise<DevicePublicIdentity>;
  loadKeyEpoch?(
    epoch: number,
    signal: AbortSignal,
  ): Promise<NotebookEpochKey | undefined>;
  onPresence?(presence: NotebookPresence): void;
  onError?(error: Error): void;
  /**
   * The notebook's workspace documents, loaded or not. With it, remote
   * changes for pages that are not open are merged through the runtime, and
   * local changes of those pages are captured from its change feed.
   */
  workspace?: SyncWorkspaceDocumentsPort;
}

/** Owns local capture, durable outbox, Realtime wakeups, catch-up and remote application. */
export class NotebookSyncRuntime {
  readonly documents: DocHandleSyncBridge;
  readonly coordinator: SyncCoordinator;
  private detachWorkspace?: () => void;

  constructor(options: NotebookSyncRuntimeOptions) {
    this.documents = new DocHandleSyncBridge(options.workspace);
    options.services.transport.setAssetUploadIdentity?.(options.identity);
    this.coordinator = new SyncCoordinator({
      notebookId: options.notebookId,
      deviceId: options.identity.publicIdentity.deviceId,
      auth: options.services.auth,
      transport: options.services.transport,
      realtime: options.services.realtime,
      durable: options.durable,
      crypto: new NotebookCryptoAdapter({
        notebookId: options.notebookId,
        identity: options.identity,
        keyring: options.keyring,
        resolveSender: options.resolveSender,
        loadKeyEpoch: options.loadKeyEpoch,
      }),
      documents: this.documents,
      network: options.network ?? new BrowserNetworkState(),
      onPresence: options.onPresence,
      onError: options.onError,
    });
  }

  registerDocument<T extends object>(
    documentId: string,
    handle: DocHandle<T>,
  ): () => void {
    return this.documents.register(documentId, handle, (id, change) =>
      this.coordinator.enqueueLocalChange(id, change),
    );
  }

  start(): Promise<void> {
    this.detachWorkspace ??= this.documents.attachWorkspace((id, change) =>
      this.coordinator.enqueueLocalChange(id, change),
    );
    return this.coordinator.start();
  }
  stop(): Promise<void> {
    this.detachWorkspace?.();
    this.detachWorkspace = undefined;
    return this.coordinator.stop();
  }
  syncNow(): Promise<void> {
    return this.coordinator.syncNow();
  }
}

/** Registration is server-authoritative: pending devices never enter the coordinator. */
export async function registerDeviceAndRequireActivation(
  services: AppwriteSyncServices,
  identity: DeviceSecretIdentity,
): Promise<void> {
  const result = await services.directory.registerDevice(
    identity.publicIdentity,
  );
  if (result.device.status !== "active") {
    throw new SyncClientError(
      "key-epoch-unavailable",
      result.device.status === "pending"
        ? "This device is waiting for approval from an active device or recovery flow."
        : "This device has been revoked and cannot synchronize.",
    );
  }
}

/** Resolves collaborator signing keys from the membership-gated active-device directory. */
export function createNotebookDeviceResolver(
  directory: SyncDeviceDirectoryPort,
  notebookId: string,
): (deviceId: string) => Promise<DevicePublicIdentity> {
  let cached: Map<string, DevicePublicIdentity> | undefined;
  const refresh = async () => {
    const devices = new Map<string, DevicePublicIdentity>();
    let cursor: string | undefined;
    do {
      const page = await directory.listNotebookDevices({
        notebookId,
        ...(cursor ? { cursor } : {}),
        limit: 50,
      });
      for (const device of page.devices) {
        if (device.status !== "active")
          throw new SyncClientError(
            "protocol-error",
            "Inactive sender appeared in the notebook device directory.",
          );
        const existing = devices.get(device.deviceId);
        if (
          existing &&
          (!sameBytes(
            existing.encryptionPublicKey,
            device.encryptionPublicKey,
          ) ||
            !sameBytes(existing.signingPublicKey, device.signingPublicKey))
        ) {
          throw new SyncClientError(
            "protocol-error",
            "Notebook device identity changed during directory pagination.",
          );
        }
        devices.set(device.deviceId, {
          protocolVersion: 1,
          accountId: "notebook-member",
          deviceId: device.deviceId,
          encryptionPublicKey: device.encryptionPublicKey,
          signingPublicKey: device.signingPublicKey,
        });
      }
      cursor = page.nextCursor;
    } while (cursor && devices.size < 5_000);
    if (cursor)
      throw new SyncClientError(
        "protocol-error",
        "Notebook device directory exceeds the supported bound.",
      );
    cached = devices;
  };
  return async (deviceId) => {
    if (!cached?.has(deviceId)) await refresh();
    const identity = cached?.get(deviceId);
    if (!identity)
      throw new SyncClientError(
        "protocol-error",
        "The encrypted change sender is not an active notebook device.",
      );
    return structuredClone(identity);
  };
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index])
  );
}
