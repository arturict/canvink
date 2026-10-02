/**
 * What this account may do in each shared notebook of the workspace, and the read-only guard that
 * follows from it.
 *
 * The room decides the role. This store only holds what the room last said (a `welcome` or a `role`
 * frame of the live session), remembered in the joined-room record so that a notebook reopens
 * the way it was left. A notebook this device shares itself is `owner`; a notebook that is not
 * shared at all has no entry and is the person's own.
 *
 * A notebook whose role is not known yet (a record from before roles existed, or a notebook that
 * arrived from another device of the account) counts as read-only until the room confirms it: the
 * safe side, since an edit that the room would refuse could not be sent anyway.
 */

import { useEffect, useLayoutEffect, useMemo, useSyncExternalStore } from 'react';
import { roleCanManage, roleCanWrite, type Role } from '../../collab/protocol';
import { setReadOnlyDocuments } from '../../storage/readOnlyDocuments';
import type { V2RuntimeState } from '../../storage/workspaceV2Runtime';
import { loadJoinedRooms, saveJoinedRoom } from './joinedRoomStore';
import { loadOwnerRooms } from './ownerRoomStore';

const live = new Map<string, Role>();
let version = 0;
const listeners = new Set<() => void>();

function emit(): void {
  version += 1;
  for (const listener of [...listeners]) listener();
}

/** Records the role a live session reported for a notebook, and remembers it for the next start. */
export function reportNotebookRole(notebookId: string, role: Role): void {
  const joined = loadJoinedRooms()[notebookId];
  if (joined && joined.role !== role) saveJoinedRoom(notebookId, { roomId: joined.roomId, role });
  if (live.get(notebookId) === role) return;
  live.set(notebookId, role);
  emit();
}

/** Forgets the live role of a notebook that is no longer bound to a room. */
export function forgetNotebookRole(notebookId: string): void {
  if (live.delete(notebookId)) emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export interface NotebookAccess {
  /** Role per shared notebook id; a notebook that is not shared has no entry. */
  readonly roles: ReadonlyMap<string, Role>;
  /** Whether the notebook may only be read on this device. */
  isReadOnly(notebookId: string): boolean;
  /** Whether the person may invite people and manage the link of the notebook. */
  canManage(notebookId: string): boolean;
}

/**
 * The role of every shared notebook of the workspace, and, as a side effect, the registry of
 * documents the storage layer refuses to change (`src/storage/readOnlyDocuments.ts`).
 *
 * `bindTrigger` is bumped by the app after a share was created, joined or left, because those
 * change the local records without changing the workspace.
 */
export function useNotebookAccess(workspace: V2RuntimeState | null, bindTrigger: number): NotebookAccess {
  const liveVersion = useSyncExternalStore(subscribe, () => version, () => 0);
  const roles = useMemo(() => {
    void liveVersion;
    void bindTrigger;
    const owned = loadOwnerRooms();
    const joined = loadJoinedRooms();
    const result = new Map<string, Role>();
    for (const notebook of workspace?.notebooks ?? []) {
      if (owned[notebook.notebookId]) {
        result.set(notebook.notebookId, 'owner');
        continue;
      }
      const record = joined[notebook.notebookId];
      if (!record) continue;
      result.set(notebook.notebookId, live.get(notebook.notebookId) ?? record.role ?? 'viewer');
    }
    return result;
  }, [workspace, bindTrigger, liveVersion]);

  const readOnlyDocumentIds = useMemo(() => {
    const ids: string[] = [];
    for (const notebook of workspace?.notebooks ?? []) {
      if (roleCanWrite(roles.get(notebook.notebookId) ?? 'owner')) continue;
      ids.push(notebook.documentId);
      for (const section of notebook.sections) ids.push(...section.pageDocumentIds);
    }
    return ids;
  }, [workspace, roles]);
  // Before paint, so that no edit slips in between a role change and the guard.
  useLayoutEffect(() => {
    setReadOnlyDocuments(readOnlyDocumentIds);
  }, [readOnlyDocumentIds]);
  useEffect(() => () => setReadOnlyDocuments([]), []);

  return useMemo<NotebookAccess>(() => ({
    roles,
    isReadOnly: (notebookId) => !roleCanWrite(roles.get(notebookId) ?? 'owner'),
    canManage: (notebookId) => roleCanManage(roles.get(notebookId) ?? 'owner'),
  }), [roles]);
}
