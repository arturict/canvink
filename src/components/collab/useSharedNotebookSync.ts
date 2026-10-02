/**
 * Keeps every shared notebook of the workspace connected to its room.
 *
 * A notebook is shared when this device created the share (an owner record,
 * see `ownerRoomStore.ts`) or when it was joined through a link (a member
 * record, see `joinedRoomStore.ts`). For each such notebook this opens a
 * `RoomSession` and binds it to the runtime via `bindEditorSession` +
 * `createRuntimeEditorPort`. The binding follows the notebook's page set
 * itself (the port reports document-set changes): a page that appears while
 * shared is `announce`d and `snapshot`ted *before* any incremental `append`
 * (the backend rejects `append` for an undeclared doc with `unknown-doc`), a
 * page that disappears is `remove`d from the room, and a page another member
 * created is adopted into the workspace. Pages do not have to be open: the
 * port reads and merges unloaded pages through the runtime.
 *
 * The owner authenticates with the room's `ownerToken`; a member with the
 * account token, which the Worker accepts for a registered member without a
 * link. A member binding therefore needs a signed-in account and waits for
 * one. The role the room grants (`welcome`, and a `role` frame when it
 * changes mid-session) is reported to `notebookAccess.ts`, which makes a
 * reader's notebook read-only; the session itself never sends a reader's
 * writes and the room refuses them anyway. Either session keeps room documents as compact bytes
 * (`docStorage: 'bytes'`); the persisted workspace is the real copy, so a
 * second set of live Automerge documents would only double the memory.
 */

import { useEffect, useRef, useState } from 'react';
import {
  bindEditorSession,
  openRoomSession,
  PresenceHub,
  roleCanWrite,
  setOwnerProfile,
  type AuthCredential,
  type PresenceUser,
  type Role,
  type RoomSession,
} from '../../collab';
import { startRoomInkSync, type RoomInkSync } from '../../collab/roomInkSync';
import { createRoomSegmentClient } from '../../collab/roomSegments';
import type { V2RuntimeState, WorkspaceV2Runtime } from '../../storage/workspaceV2Runtime';
import { collabSource, createRuntimeEditorPort } from './runtimeEditorPort';
import { adoptRemotePage } from './adoptSharedDocuments';
import { getOwnerRoom } from './ownerRoomStore';
import { getJoinedRoom, removeJoinedRoom } from './joinedRoomStore';
import { forgetNotebookRole, reportNotebookRole } from './notebookAccess';

/** How a device proves it may read and write a room. */
type RoomCredential =
  | { kind: 'owner'; roomId: string; ownerToken: string }
  | { kind: 'member'; roomId: string };

interface BoundRoom {
  session: RoomSession;
  credential: RoomCredential;
  unbind: () => void;
  /** Live presence of the room; lives as long as the session. */
  presence: PresenceHub;
  /** Keeps the notebook's ink segments in the room. */
  ink: RoomInkSync;
}

const NO_HUBS: ReadonlyMap<string, PresenceHub> = new Map();

export interface UseSharedNotebookSyncParams {
  runtime: WorkspaceV2Runtime | null;
  workspace: V2RuntimeState | null;
  syncUrl: string | undefined;
  /**
   * Bumped by the caller after a room was created, joined or left. A changed
   * record doesn't change `runtime`/`workspace`/`syncUrl` on its own, so
   * without this the bind effect below would only pick up rooms that already
   * existed when the component mounted.
   */
  bindTrigger?: number;
  /** Who this device is to the others in a shared notebook (name, colour, picture). */
  presenceUser?: PresenceUser;
  /** The account token for member rooms; `null` while signed out. */
  getAccountToken?: () => Promise<string | null>;
  /** Whether an account is signed in (member rooms connect only then). */
  signedIn?: boolean;
  /** The Worker no longer lets this account into a room (access was withdrawn or the room is gone). */
  onAccessLost?: (notebookId: string) => void;
  /** Adopting a page another member created failed. */
  onAdoptFailed?: (notebookId: string, error: unknown) => void;
  /** The room changed this account's role while the notebook was open (a promotion or a demotion). */
  onRoleChanged?: (notebookId: string, role: Role) => void;
}

function credentialFor(notebookId: string): RoomCredential | undefined {
  const owner = getOwnerRoom(notebookId);
  if (owner) return { kind: 'owner', roomId: owner.roomId, ownerToken: owner.ownerToken };
  const joined = getJoinedRoom(notebookId);
  return joined ? { kind: 'member', roomId: joined.roomId } : undefined;
}

function sameCredential(left: RoomCredential, right: RoomCredential): boolean {
  return left.kind === right.kind && left.roomId === right.roomId
    && (left.kind !== 'owner' || (right.kind === 'owner' && left.ownerToken === right.ownerToken));
}

function bindRoom(
  runtime: WorkspaceV2Runtime,
  syncUrl: string,
  notebookId: string,
  credential: RoomCredential,
  presenceUser: PresenceUser,
  getAccountToken: () => Promise<string | null>,
  handlers: Pick<UseSharedNotebookSyncParams, 'onAccessLost' | 'onAdoptFailed' | 'onRoleChanged'>,
): BoundRoom {
  let live = false;
  let lastRole: Role | undefined;
  const room: { ink?: RoomInkSync } = {};
  const memberAuth = async (): Promise<AuthCredential> => {
    const jwt = await getAccountToken();
    if (!jwt) throw new Error('Signed out.');
    return { kind: 'user', jwt };
  };
  const auth: AuthCredential = credential.kind === 'owner'
    ? { kind: 'owner', ownerToken: credential.ownerToken }
    : { kind: 'user', jwt: '' };
  let ownerAnnounced = false;
  const announceOwner = (): void => {
    // The signed-in owner tells the room who they are (the member list shows it) once per session.
    if (credential.kind !== 'owner' || ownerAnnounced) return;
    ownerAnnounced = true;
    void getAccountToken().then((jwt) => {
      if (!jwt) return;
      return setOwnerProfile(
        { syncUrl, appOrigin: typeof window === 'undefined' ? '' : window.location.origin },
        credential.roomId,
        credential.ownerToken,
        jwt,
      );
    }).catch(() => {
      ownerAnnounced = false;
    });
  };
  const session = openRoomSession({
    syncUrl,
    roomId: credential.roomId,
    auth,
    ...(credential.kind === 'member' ? { getAuth: memberAuth } : {}),
    // The documents are persisted locally, so offline work is sent by
    // reconciling with the room after each catch-up rather than from an
    // in-memory queue that a reload would lose.
    resyncStrategy: 'reconcile',
    docStorage: 'bytes',
    callbacks: {
      onStatus: (status) => {
        live = status === 'live';
        if (live) {
          room.ink?.wake();
          announceOwner();
        }
      },
      onRole: (role) => {
        const previous = lastRole;
        lastRole = role;
        reportNotebookRole(notebookId, role);
        if (previous !== undefined && previous !== role) handlers.onRoleChanged?.(notebookId, role);
        // A promotion lets the device send what a reader could not.
        if (roleCanWrite(role)) room.ink?.wake();
      },
      onError: (error) => {
        if (error.code === 'unauthorized') handlers.onAccessLost?.(notebookId);
      },
    },
  });
  const unbind = bindEditorSession(session, createRuntimeEditorPort(runtime, notebookId, {
    onRemoteDocAdded: (docId, kind, bytes) => {
      void adoptRemotePage(runtime, notebookId, docId, kind, bytes)
        // Frames that arrived while the page was being adopted were skipped (the page was not local
        // yet), so the room's current copy is merged once it is.
        .then(() => {
          const latest = session.getDocBytes(docId);
          if (!latest || kind !== 'page') return undefined;
          return runtime.applyRemoteDocumentChanges(docId, latest, { source: collabSource(notebookId) });
        })
        .catch((error: unknown) => {
          handlers.onAdoptFailed?.(notebookId, error);
        });
    },
  }));
  const presence = new PresenceHub(session, { user: presenceUser });
  // Ink lives in segments beside the documents; the room needs them for everyone else.
  const client = createRoomSegmentClient(
    { syncUrl, appOrigin: typeof window === 'undefined' ? '' : window.location.origin },
    credential.roomId,
    async () => {
      if (credential.kind === 'owner') return { kind: 'owner', ownerToken: credential.ownerToken };
      const jwt = await getAccountToken();
      if (!jwt) throw new Error('Signed out.');
      return { kind: 'user', jwt };
    },
  );
  // A reader only downloads segments; the room refuses uploads of a reader.
  const ink = startRoomInkSync({
    runtime,
    notebookId,
    client,
    remoteKey: `room:${credential.roomId}`,
    canRun: () => live && roleCanWrite(session.getRole()),
  });
  room.ink = ink;
  return { session, credential, unbind, presence, ink };
}

const ANONYMOUS_OWNER: PresenceUser = { id: 'owner', name: 'Owner', color: '#65716b' };
const NO_TOKEN = (): Promise<string | null> => Promise.resolve(null);

function closeBound(entry: BoundRoom, notebookId: string): void {
  forgetNotebookRole(notebookId);
  entry.unbind();
  entry.presence.dispose();
  entry.ink.stop();
  entry.session.close();
}

/**
 * Returns the presence hub of every shared notebook of this workspace, keyed
 * by notebook id; notebooks that are not shared have none.
 */
export function useSharedNotebookSync(params: UseSharedNotebookSyncParams): ReadonlyMap<string, PresenceHub> {
  const boundRef = useRef<Map<string, BoundRoom>>(new Map());
  const [hubs, setHubs] = useState<ReadonlyMap<string, PresenceHub>>(NO_HUBS);
  const {
    runtime, workspace, syncUrl, bindTrigger, presenceUser = ANONYMOUS_OWNER, signedIn = false,
    getAccountToken = NO_TOKEN,
  } = params;
  const presenceUserRef = useRef(presenceUser);
  const handlersRef = useRef({
    getAccountToken,
    onAccessLost: params.onAccessLost,
    onAdoptFailed: params.onAdoptFailed,
    onRoleChanged: params.onRoleChanged,
  });
  useEffect(() => {
    handlersRef.current = {
      getAccountToken,
      onAccessLost: params.onAccessLost,
      onAdoptFailed: params.onAdoptFailed,
      onRoleChanged: params.onRoleChanged,
    };
  });

  useEffect(() => {
    presenceUserRef.current = presenceUser;
    for (const entry of boundRef.current.values()) entry.presence.setUser(presenceUser);
  }, [presenceUser]);

  const publishHubs = (): void => {
    const next = new Map([...boundRef.current].map(([notebookId, entry]) => [notebookId, entry.presence]));
    setHubs((current) => (
      current.size === next.size && [...next].every(([key, hub]) => current.get(key) === hub) ? current : next
    ));
  };

  useEffect(() => {
    if (!runtime || !workspace || !syncUrl) return;
    const bound = boundRef.current;
    // A notebook in the trash is out of the person's way: it stops syncing until it is restored.
    const trashed = new Set(workspace.activation.manifest.trash.flatMap(
      (entry) => entry.kind === 'notebook' && entry.notebookDocumentId ? [entry.notebookDocumentId] : [],
    ));
    for (const notebook of workspace.notebooks) {
      const record = trashed.has(notebook.documentId) ? undefined : credentialFor(notebook.notebookId);
      // A member room needs the account; without it the notebook stays an ordinary local one.
      const credential = record && (record.kind === 'owner' || signedIn) ? record : undefined;
      const existing = bound.get(notebook.notebookId);
      if (existing && (!credential || !sameCredential(existing.credential, credential))) {
        // B2: the owner ended sharing, the notebook was left, or the account signed out.
        closeBound(existing, notebook.notebookId);
        bound.delete(notebook.notebookId);
      }
      if (!credential || bound.has(notebook.notebookId)) continue;
      const handlers = {
        onAccessLost: (notebookId: string) => {
          // Another session of the same notebook may have replaced this one already.
          const current = bound.get(notebookId);
          if (!current || current.credential.kind !== 'member') return;
          closeBound(current, notebookId);
          bound.delete(notebookId);
          removeJoinedRoom(notebookId);
          publishHubs();
          handlersRef.current.onAccessLost?.(notebookId);
        },
        onAdoptFailed: (notebookId: string, error: unknown) => handlersRef.current.onAdoptFailed?.(notebookId, error),
        onRoleChanged: (notebookId: string, role: Role) => handlersRef.current.onRoleChanged?.(notebookId, role),
      };
      bound.set(
        notebook.notebookId,
        bindRoom(
          runtime,
          syncUrl,
          notebook.notebookId,
          credential,
          presenceUserRef.current,
          () => handlersRef.current.getAccountToken(),
          handlers,
        ),
      );
    }
    // A notebook that left the workspace takes its binding with it.
    const present = new Set(workspace.notebooks.map((notebook) => notebook.notebookId));
    for (const [notebookId, entry] of [...bound]) {
      if (present.has(notebookId)) continue;
      closeBound(entry, notebookId);
      bound.delete(notebookId);
    }
    publishHubs();
  }, [runtime, workspace, syncUrl, bindTrigger, signedIn]);

  useEffect(() => {
    const bound = boundRef.current;
    return () => {
      for (const [notebookId, entry] of bound) closeBound(entry, notebookId);
      bound.clear();
    };
  }, []);

  return hubs;
}
