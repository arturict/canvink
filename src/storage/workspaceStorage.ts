import { get, set } from "idb-keyval";
import { normalizeStoredWorkspace } from "../domain/workspace";
import { trashImportedOneNoteRecycleBin } from "../domain/oneNoteRecycleBin";
import { assertWorkspaceShape } from "../domain/validation";
import type { WorkspaceState } from "../domain/types";
import { validateWorkspaceAssetPreviews } from "../io/files";
import { SerialTaskQueue } from "./serialTaskQueue";

const STORAGE_KEY = "canvink:workspace:v1";
const BROWSER_WRITE_LOCK = "canvink:workspace:v1:writer";
const saveQueue = new SerialTaskQueue();
let browserWriteLockAcquired = false;
let browserWriteLockAcquisition: Promise<void> | undefined;
let browserWriteLockLifetime: Promise<unknown> | undefined;

export type StorageBackend = "tauri" | "indexeddb";
export type WorkspaceOpenFailureCode =
  | "writer-conflict"
  | "coordination-unavailable";

export class WorkspaceOpenError extends Error {
  constructor(
    public readonly code: WorkspaceOpenFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceOpenError";
  }
}

export function hasTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.__TAURI_INTERNALS__ !== "undefined"
  );
}

export function activeStorageBackend(): StorageBackend {
  return hasTauriRuntime() ? "tauri" : "indexeddb";
}

function acquireBrowserWriteLock(): Promise<void> {
  if (browserWriteLockAcquired) return Promise.resolve();
  if (browserWriteLockAcquisition) return browserWriteLockAcquisition;
  if (typeof navigator === "undefined" || !("locks" in navigator)) {
    return Promise.reject(
      new WorkspaceOpenError(
        "coordination-unavailable",
        "This browser cannot safely coordinate local writes. Use a current browser with Web Locks support or install the desktop app.",
      ),
    );
  }

  browserWriteLockAcquisition = new Promise<void>((resolve, reject) => {
    let settled = false;
    browserWriteLockLifetime = navigator.locks.request(
      BROWSER_WRITE_LOCK,
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        if (!lock) {
          settled = true;
          reject(
            new WorkspaceOpenError(
              "writer-conflict",
              "Canvink is already open in another browser tab. Close that tab, then reload this one to edit safely.",
            ),
          );
          return;
        }

        browserWriteLockAcquired = true;
        settled = true;
        resolve();
        await new Promise<void>(() => undefined);
      },
    );
    browserWriteLockLifetime.catch((error: unknown) => {
      if (!settled) {
        reject(
          error instanceof Error
            ? error
            : new Error("Could not acquire the browser workspace write lock."),
        );
      }
    });
  });
  return browserWriteLockAcquisition;
}

/** Acquire the single-writer boundary before reading either v1 or v2 authority. */
export async function acquireWorkspaceWriteAccess(): Promise<StorageBackend> {
  if (hasTauriRuntime()) return "tauri";
  try {
    await acquireBrowserWriteLock();
  } catch (error) {
    // A rejected `ifAvailable` attempt is not the lifetime lock. Allow an
    // explicit recovery retry after the conflicting tab has released it.
    browserWriteLockAcquisition = undefined;
    throw error;
  }
  return "indexeddb";
}

export async function loadWorkspace(): Promise<{
  workspace: WorkspaceState;
  backend: StorageBackend;
}> {
  if (hasTauriRuntime()) {
    const { invoke } = await import("@tauri-apps/api/core");
    const value = await invoke<unknown>("load_workspace");
    const stored = normalizeStoredWorkspace(value);
    const workspace = trashImportedOneNoteRecycleBin(stored.workspace);
    await validateWorkspaceAssetPreviews(workspace);
    if (stored.storageState === "uninitialized" || workspace !== stored.workspace) {
      await saveWorkspace(workspace);
    }
    return { workspace, backend: "tauri" };
  }

  await acquireWorkspaceWriteAccess();
  const value = await get<unknown>(STORAGE_KEY);
  const stored = normalizeStoredWorkspace(value);
  // One-time cleanup of the recycle bin older OneNote imports brought along.
  const workspace = trashImportedOneNoteRecycleBin(stored.workspace);
  await validateWorkspaceAssetPreviews(workspace);
  if (stored.storageState === "uninitialized" || workspace !== stored.workspace) {
    await saveWorkspace(workspace);
  }
  return {
    workspace,
    backend: "indexeddb",
  };
}

export async function saveWorkspace(
  workspace: WorkspaceState,
): Promise<StorageBackend> {
  const snapshot = structuredClone(workspace);
  assertWorkspaceShape(snapshot);
  const backend = activeStorageBackend();

  return saveQueue.enqueue(async () => {
    if (backend === "tauri") {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("save_workspace", { workspace: snapshot });
      return "tauri";
    }

    if (!browserWriteLockAcquired) {
      throw new Error("The browser workspace write lock is not held.");
    }
    await set(STORAGE_KEY, snapshot);
    return "indexeddb";
  });
}
