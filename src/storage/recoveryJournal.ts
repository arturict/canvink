import { del, get, set } from 'idb-keyval';
import type { WorkspaceState } from '../domain/types';
import { assertWorkspaceShape } from '../domain/validation';
import { validateWorkspaceAssetPreviews } from '../io/files';
import { SerialTaskQueue } from './serialTaskQueue';

const RECOVERY_KEY = 'canvink:recovery:v1';
const RECOVERY_ENVELOPE_VERSION = 1 as const;
const recoveryQueue = new SerialTaskQueue();

export interface RecoveryMarker {
  sessionId: string;
  revision: number;
}

export interface RecoveryDraft extends RecoveryMarker {
  version: typeof RECOVERY_ENVELOPE_VERSION;
  capturedAt: string;
  workspace: WorkspaceState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRecoveryDraft(value: unknown): RecoveryDraft | null {
  if (value === undefined) return null;
  if (
    !isRecord(value) ||
    value.version !== RECOVERY_ENVELOPE_VERSION ||
    typeof value.sessionId !== 'string' ||
    !value.sessionId.trim() ||
    typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    typeof value.capturedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.capturedAt))
  ) {
    throw new Error('The local recovery draft is malformed and was not changed.');
  }

  assertWorkspaceShape(value.workspace);
  return value as unknown as RecoveryDraft;
}

export async function loadRecoveryDraft(): Promise<RecoveryDraft | null> {
  const draft = parseRecoveryDraft(await get<unknown>(RECOVERY_KEY));
  if (draft) {
    await validateWorkspaceAssetPreviews(draft.workspace);
  }
  return draft;
}

export function recoveryDraftDiffersFrom(
  draft: RecoveryDraft,
  savedWorkspace: WorkspaceState,
): boolean {
  if (draft.workspace.updatedAt !== savedWorkspace.updatedAt) return true;
  if (draft.workspace.activeNotebookId !== savedWorkspace.activeNotebookId) return true;
  if (draft.workspace.activeSectionId !== savedWorkspace.activeSectionId) return true;
  if (draft.workspace.activePageId !== savedWorkspace.activePageId) return true;
  return JSON.stringify(draft.workspace) !== JSON.stringify(savedWorkspace);
}

export function saveRecoveryDraft(
  workspace: WorkspaceState,
  marker: RecoveryMarker,
): Promise<void> {
  const snapshot = structuredClone(workspace);
  assertWorkspaceShape(snapshot);
  const draft: RecoveryDraft = {
    version: RECOVERY_ENVELOPE_VERSION,
    sessionId: marker.sessionId,
    revision: marker.revision,
    capturedAt: new Date().toISOString(),
    workspace: snapshot,
  };

  return recoveryQueue.enqueue(() => set(RECOVERY_KEY, draft));
}

export function clearRecoveryDraftThrough(marker: RecoveryMarker): Promise<void> {
  return recoveryQueue.enqueue(async () => {
    const current = parseRecoveryDraft(await get<unknown>(RECOVERY_KEY));
    if (
      current?.sessionId === marker.sessionId &&
      current.revision <= marker.revision
    ) {
      await del(RECOVERY_KEY);
    }
  });
}

export function discardRecoveryDraft(draft: RecoveryDraft): Promise<boolean> {
  return recoveryQueue.enqueue(async () => {
    const current = parseRecoveryDraft(await get<unknown>(RECOVERY_KEY));
    if (
      current?.sessionId !== draft.sessionId ||
      current.revision !== draft.revision
    ) {
      return false;
    }
    await del(RECOVERY_KEY);
    return true;
  });
}
