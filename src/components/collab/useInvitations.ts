/**
 * "Mit dir geteilt": the notebooks that were shared with a verified e-mail address of the signed-in
 * account and that it has not opened yet.
 *
 * Nothing is sent by e-mail. The person who shared invited an address; the Worker lists the
 * invitations for the account's verified addresses (`GET /api/v1/me/invitations`), and opening one
 * claims it: the room recognises the account by its verified address and lets it in with the invited
 * role. The notebook is then adopted into the workspace exactly like a link join.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { declineInvitation, listInvitations, type Invitation } from '../../collab';
import type { OptionalAuthValue } from '../../auth';
import type { V2RuntimeState, WorkspaceV2Runtime } from '../../storage/workspaceV2Runtime';
import { adoptSharedNotebook, fetchSharedNotebook } from './adoptSharedDocuments';
import { loadJoinedRooms, saveJoinedRoom } from './joinedRoomStore';
import { loadOwnerRooms } from './ownerRoomStore';

/** How often the list is refreshed while the app stays open; it is also refreshed when the tab is shown again. */
const REFRESH_MS = 2 * 60_000;

export interface UseInvitationsParams {
  runtime: WorkspaceV2Runtime | null;
  workspace: V2RuntimeState | null;
  syncUrl: string | undefined;
  auth: OptionalAuthValue;
  /** The personal space decided how this device links to the account; a notebook adopted earlier could be replaced. */
  accountReady: boolean;
  /** The notebook is part of the workspace now; show it. */
  onJoined(notebookId: string, added: boolean): void;
  /** Opening an invitation did not work. */
  onFailed(): void;
}

export interface UseInvitationsResult {
  invitations: readonly Invitation[];
  /** The room being opened right now. */
  busyRoomId: string | null;
  open(invitation: Invitation): void;
  decline(invitation: Invitation): void;
}

const NONE: readonly Invitation[] = [];

function roomIsInWorkspace(roomId: string, workspace: V2RuntimeState | null): boolean {
  const known = [
    ...Object.entries(loadOwnerRooms()).filter(([, record]) => record.roomId === roomId),
    ...Object.entries(loadJoinedRooms()).filter(([, record]) => record.roomId === roomId),
  ];
  return known.some(([notebookId]) => workspace?.notebooks.some((notebook) => notebook.notebookId === notebookId));
}

export function useInvitations(params: UseInvitationsParams): UseInvitationsResult {
  const { syncUrl, auth, workspace, accountReady } = params;
  const [listed, setListed] = useState<readonly Invitation[]>(NONE);
  const [busyRoomId, setBusyRoomId] = useState<string | null>(null);
  const paramsRef = useRef(params);
  useEffect(() => {
    paramsRef.current = params;
  });
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  const signedIn = auth.available && auth.isSignedIn;
  const getToken = auth.available ? auth.getToken : undefined;

  const refresh = useCallback(async (): Promise<void> => {
    // Offline, the request could only fail (and the browser logs every failed request).
    if (!syncUrl || !getToken || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
    try {
      const jwt = await getToken();
      if (!jwt) return;
      const invitations = await listInvitations({ syncUrl, appOrigin: window.location.origin }, jwt);
      if (aliveRef.current) setListed(invitations);
    } catch {
      // The list is a convenience: a failed refresh leaves what is shown and tries again later.
    }
  }, [syncUrl, getToken]);

  useEffect(() => {
    if (!signedIn || !syncUrl) return;
    const first = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [signedIn, syncUrl, refresh]);

  const open = useCallback((invitation: Invitation): void => {
    const { runtime, onJoined, onFailed } = paramsRef.current;
    if (!runtime || !syncUrl || !getToken || !accountReady || busyRoomId) return;
    setBusyRoomId(invitation.roomId);
    void (async () => {
      try {
        const shared = await fetchSharedNotebook({ syncUrl, roomId: invitation.roomId, getToken: () => getToken() });
        const adopted = await adoptSharedNotebook(runtime, shared);
        if (!loadOwnerRooms()[adopted.notebookId]) saveJoinedRoom(adopted.notebookId, { roomId: shared.roomId, role: shared.role });
        if (!aliveRef.current) return;
        setListed((current) => current.filter((entry) => entry.roomId !== invitation.roomId));
        onJoined(adopted.notebookId, adopted.added);
      } catch {
        if (aliveRef.current) onFailed();
      } finally {
        if (aliveRef.current) setBusyRoomId(null);
        void refresh();
      }
    })();
  }, [syncUrl, getToken, accountReady, busyRoomId, refresh]);

  const decline = useCallback((invitation: Invitation): void => {
    if (!syncUrl || !getToken) return;
    setListed((current) => current.filter((entry) => entry.roomId !== invitation.roomId));
    void (async () => {
      try {
        const jwt = await getToken();
        if (jwt) await declineInvitation({ syncUrl, appOrigin: window.location.origin }, jwt, invitation.roomId);
      } catch {
        // The invitation stays in the room; it shows up again at the next refresh.
      } finally {
        void refresh();
      }
    })();
  }, [syncUrl, getToken, refresh]);

  // Signed out, or while the personal space still decides how this device links to the account,
  // nothing is offered: a notebook opened before that could be replaced by the account's workspace.
  const shown = signedIn && syncUrl && accountReady ? listed : NONE;
  const visible = shown.filter((invitation) => !roomIsInWorkspace(invitation.roomId, workspace));
  return { invitations: visible.length === shown.length ? shown : visible, busyRoomId, open, decline };
}
