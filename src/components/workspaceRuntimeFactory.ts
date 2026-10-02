import {
  WorkerAutomergeMigrationMaterializer,
  WorkerAutomergeRepoMigrationAdapter,
} from '../storage/automergeTaskClient';
import type { MigrationProgress } from '../storage/v2WorkspaceStorage';
import {
  BrowserV2WorkspaceActivationStore,
  createBrowserV2WorkspaceMigrationOrchestrator,
} from '../storage/v2WorkspaceStorage';
import {
  createBrowserWorkspaceV2Runtime,
  createTauriWorkspaceV2Runtime,
  type WorkspaceV2Runtime,
} from '../storage/workspaceV2Runtime';

/**
 * The workspace runtime of this platform: the desktop and phone apps store
 * through Tauri, the browser in IndexedDB. Shared by the notebook shell
 * (V2NotebookApp) and the phone shell (src/mobile), which add their own
 * startup behaviour around it.
 */
export function createPlatformWorkspaceRuntime(
  onMigrationProgress: (progress: MigrationProgress) => void,
  startPageId: () => string | undefined,
): WorkspaceV2Runtime | Promise<WorkspaceV2Runtime> {
  if (typeof window !== 'undefined' && typeof window.__TAURI_INTERNALS__ !== 'undefined') {
    return createTauriWorkspaceV2Runtime({ onMigrationProgress, startPageId });
  }
  const activationStore = new BrowserV2WorkspaceActivationStore();
  return createBrowserWorkspaceV2Runtime({
    activationStore,
    onProgress: onMigrationProgress,
    startPageId,
    migrationFactory: () => createBrowserV2WorkspaceMigrationOrchestrator({
      activationStore,
      onProgress: onMigrationProgress,
      repo: new WorkerAutomergeRepoMigrationAdapter(),
      materializer: new WorkerAutomergeMigrationMaterializer(),
    }),
  });
}
