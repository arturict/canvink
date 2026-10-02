/**
 * The real `CollabGateway` (see `collabGateway.ts`) implemented on top of
 * `src/collab/`. `src/components/collab/*` never imports the network client
 * directly outside this file and `useSharedNotebookSync`/`runtimeEditorPort`, so
 * the rest of the UI stays wired only against the gateway interface.
 */

import * as Automerge from '@automerge/automerge';
import {
  buildInviteUrl,
  changeMemberRole,
  createRoomFromDocs,
  createViewerStore,
  deleteRoom,
  fetchRoomMeta,
  fetchRoomSharing,
  inviteByEmail,
  leaveRoom,
  openRoomSession,
  regenerateLink,
  removeMember,
  revokeInvite,
  setLinkEnabled,
  shareUrlFor,
  type AuthCredential,
  type ManageCredential,
  type MemberRole,
  type ConnectionStatus,
  type OwnerBridgeDoc,
  type RoomSession,
  type ViewerStore,
  type WebSocketFactory,
} from '../../collab';
import { createRoomSegmentClient } from '../../collab/roomSegments';
import type { LiveCanvinkDocumentV2 } from '../../crdt';
import { inkSegments } from '../../ink/segmentStore';
import type { WorkspaceV2Runtime } from '../../storage/workspaceV2Runtime';
import { getJoinedRoom } from './joinedRoomStore';
import { getOwnerRoom, removeOwnerRoom, saveOwnerRoom } from './ownerRoomStore';
import type {
  CollabConfig,
  CollabGateway,
  CollabRole,
  CollabSessionHandle,
  OpenSessionCredentials,
  RoomMetaView,
  SessionStatus,
  SharingView,
  ShareResult,
} from './collabGateway';

export interface RealCollabSessionHandle extends CollabSessionHandle {
  /** Underlying in-memory doc set; the join-side renderer reaches through this. */
  session: RoomSession;
  viewerStore: ViewerStore;
}

export interface RealCollabGatewayOptions {
  /** Worker origin; fixed for the lifetime of this gateway instance. */
  syncUrl: string;
  getRuntime(): WorkspaceV2Runtime | null;
  appOrigin?: string;
  webSocketFactory?: WebSocketFactory;
  fetchImpl?: typeof fetch;
  /** A fresh account token, for managing the sharing of a notebook this account joined as an admin. */
  getAccountToken?: () => Promise<string | null>;
  /**
   * Called after a room is created and persisted (see `ownerRoomStore.ts`).
   * `ShareNotebookDialog` calls `createRoomForNotebook` directly with no
   * callback back to `V2NotebookApp`, and a freshly saved room doesn't change
   * any React state on its own — this is `useSharedNotebookSync`'s signal to
   * re-check `localStorage` and bind the new room's live session, instead of
   * only ever binding rooms that already existed when the app started.
   */
  onRoomCreated?(notebookId: string): void;
  /**
   * B2: called after `unshareNotebook` deletes a room and forgets its local
   * record — the counterpart to `onRoomCreated`, so `useSharedNotebookSync` can
   * re-check `localStorage` and unbind the now-gone room's live session.
   */
  onRoomRemoved?(notebookId: string): void;
}

/**
 * Exported for unit testing: this is the credential-construction step behind
 * the sign-in upgrade (a session opened with a fresh Clerk JWT after
 * `getToken()`), which can't otherwise be exercised without a
 * live Clerk instance.
 */
export function toAuthCredential(credentials: OpenSessionCredentials): AuthCredential {
  if (credentials.ownerToken) return { kind: 'owner', ownerToken: credentials.ownerToken };
  if (credentials.clerkJwt) {
    return {
      kind: 'user',
      jwt: credentials.clerkJwt,
      ...(credentials.linkSecret ? { linkSecret: credentials.linkSecret } : {}),
    };
  }
  if (credentials.linkSecret) return { kind: 'link', linkSecret: credentials.linkSecret };
  throw new Error('Opening a collab session requires an ownerToken, linkSecret, or clerkJwt.');
}

/**
 * Builds the per-connect credential resolver handed to `openRoomSession` as
 * `getAuth`. Only editor sessions with a `getClerkJwt` callback get one; every
 * other credential is static, so those sessions keep today's synchronous
 * connect path. Exported for unit testing.
 */
export function toAuthResolver(
  credentials: OpenSessionCredentials,
): (() => Promise<AuthCredential>) | undefined {
  const { getClerkJwt } = credentials;
  if (!getClerkJwt || credentials.ownerToken) return undefined;
  return async () => {
    const jwt = await getClerkJwt();
    if (jwt) return toAuthCredential({ ...credentials, clerkJwt: jwt });
    if (credentials.linkSecret) return { kind: 'link', linkSecret: credentials.linkSecret };
    return toAuthCredential(credentials);
  };
}

function toSessionStatus(status: ConnectionStatus, everLive: boolean): SessionStatus {
  switch (status) {
    case 'connecting':
    case 'syncing':
      return everLive ? { kind: 'reconnecting' } : { kind: 'connecting' };
    case 'live':
      return { kind: 'synced' };
    case 'closed':
      return { kind: 'offline' };
    case 'error':
    default:
      return { kind: 'error', message: 'The collab session lost its connection.' };
  }
}

export function createRealCollabGateway(options: RealCollabGatewayOptions): CollabGateway {
  const appOrigin = options.appOrigin
    ?? (typeof window !== 'undefined' ? window.location.origin : '');
  const httpConfig = {
    syncUrl: options.syncUrl,
    appOrigin,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  };

  /** How this device proves it may manage a notebook's sharing: the owner token, or an admin's account. */
  const manageCredential = async (notebookId: string): Promise<{ roomId: string; credential: ManageCredential }> => {
    const owned = getOwnerRoom(notebookId);
    if (owned) return { roomId: owned.roomId, credential: { kind: 'owner', ownerToken: owned.ownerToken } };
    const joined = getJoinedRoom(notebookId);
    if (!joined) throw new Error(`Notebook ${notebookId} is not shared.`);
    const jwt = await options.getAccountToken?.();
    if (!jwt) throw new Error('Managing a shared notebook needs a signed-in account.');
    return { roomId: joined.roomId, credential: { kind: 'user', jwt } };
  };

  return {
    isShared: (notebookId) => Boolean(getOwnerRoom(notebookId) ?? getJoinedRoom(notebookId)),

    async createRoomForNotebook(notebookId: string): Promise<ShareResult> {
      const runtime = options.getRuntime();
      if (!runtime) throw new Error('No active workspace runtime is available to share a notebook.');
      const state = runtime.getState();
      if (state.schemaVersion === 1) throw new Error('Sharing requires the schema-v2/v3 workspace.');
      const notebook = state.notebooks.find((candidate) => candidate.notebookId === notebookId);
      if (!notebook) throw new Error(`Notebook ${notebookId} is not part of the active workspace.`);
      const pageDocumentIds = notebook.sections.flatMap((section) => section.pageDocumentIds);
      // Pages are read one at a time while they are uploaded: a page that is
      // not loaded is read from storage for its upload and freed again.
      const read = (documentId: string) => () => runtime.readDocument(documentId, (document) => Automerge.save<LiveCanvinkDocumentV2>(document));
      const docs: OwnerBridgeDoc[] = [
        { docId: notebook.documentId, kind: 'notebook', bytes: read(notebook.documentId) },
        ...pageDocumentIds.map((documentId): OwnerBridgeDoc => ({ docId: documentId, kind: 'page', bytes: read(documentId) })),
      ];

      const result = await createRoomFromDocs(httpConfig, docs, notebook.title, {
        ...(options.webSocketFactory ? { webSocketFactory: options.webSocketFactory } : {}),
      });
      saveOwnerRoom(notebookId, { roomId: result.roomId, ownerToken: result.ownerToken });
      options.onRoomCreated?.(notebookId);
      return result;
    },

    async loadSharing(notebookId: string): Promise<SharingView> {
      const { roomId, credential } = await manageCredential(notebookId);
      let sharing = await fetchRoomSharing(httpConfig, roomId, credential);
      // A link of a room from before the on/off switch has no secret to copy: switching it on
      // (it already is) mints one without ending anyone's access.
      if (sharing.link.enabled && !sharing.link.linkSecret) {
        await setLinkEnabled(httpConfig, roomId, credential, true);
        sharing = await fetchRoomSharing(httpConfig, roomId, credential);
      }
      return {
        roomId,
        sharing,
        shareUrl: shareUrlFor(appOrigin, roomId, sharing.link),
        inviteUrl: buildInviteUrl(appOrigin, roomId),
      };
    },

    async invite(notebookId: string, email: string, role: MemberRole): Promise<void> {
      const { roomId, credential } = await manageCredential(notebookId);
      await inviteByEmail(httpConfig, roomId, credential, email, role);
    },

    async revokeInvite(notebookId: string, email: string): Promise<void> {
      const { roomId, credential } = await manageCredential(notebookId);
      await revokeInvite(httpConfig, roomId, credential, email);
    },

    async changeRole(notebookId: string, sub: string, role: MemberRole): Promise<void> {
      const { roomId, credential } = await manageCredential(notebookId);
      await changeMemberRole(httpConfig, roomId, credential, sub, role);
    },

    async removeMember(notebookId: string, sub: string): Promise<void> {
      const { roomId, credential } = await manageCredential(notebookId);
      await removeMember(httpConfig, roomId, credential, sub);
    },

    async setLinkEnabled(notebookId: string, enabled: boolean): Promise<void> {
      const { roomId, credential } = await manageCredential(notebookId);
      await setLinkEnabled(httpConfig, roomId, credential, enabled);
    },

    async regenerateLink(notebookId: string): Promise<void> {
      const { roomId, credential } = await manageCredential(notebookId);
      await regenerateLink(httpConfig, roomId, credential);
    },

    async unshareNotebook(notebookId: string): Promise<void> {
      const record = getOwnerRoom(notebookId);
      if (!record) return;
      await deleteRoom(httpConfig, record.roomId, record.ownerToken);
      removeOwnerRoom(notebookId);
      options.onRoomRemoved?.(notebookId);
    },

    async leaveNotebook(notebookId: string): Promise<void> {
      const joined = getJoinedRoom(notebookId);
      const jwt = await options.getAccountToken?.();
      if (!joined || !jwt) return;
      await leaveRoom(httpConfig, joined.roomId, jwt);
    },

    async fetchMeta(roomId: string, linkSecret: string): Promise<RoomMetaView> {
      const meta = await fetchRoomMeta(httpConfig, roomId, { kind: 'link', linkSecret });
      return { notebookTitle: meta.notebookTitle, role: meta.role, docCount: meta.docCount };
    },

    openSession(config: CollabConfig, credentials: OpenSessionCredentials): Promise<CollabSessionHandle> {
      const auth = toAuthCredential(credentials);
      const getAuth = toAuthResolver(credentials);
      return new Promise((resolve, reject) => {
        let everLive = false;
        let settled = false;
        let currentStatus: SessionStatus = { kind: 'connecting' };
        let currentRole: CollabRole = credentials.ownerToken ? 'owner' : 'viewer';
        const statusListeners = new Set<(status: SessionStatus) => void>();
        const roleListeners = new Set<(role: CollabRole) => void>();

        // Pages of this room reference ink segments the room holds; fetch them with this session's credential.
        const segmentClient = createRoomSegmentClient(httpConfig, credentials.roomId, async () => {
          if (credentials.ownerToken) return { kind: 'owner', ownerToken: credentials.ownerToken };
          const jwt = credentials.getClerkJwt ? await credentials.getClerkJwt() : credentials.clerkJwt;
          if (jwt) return { kind: 'user', jwt, ...(credentials.linkSecret ? { linkSecret: credentials.linkSecret } : {}) };
          if (credentials.linkSecret) return { kind: 'link', linkSecret: credentials.linkSecret };
          throw new Error('No credential for the ink segments of this room.');
        });
        inkSegments().setRemote(`room:${credentials.roomId}`, segmentClient.remote);

        const session = openRoomSession({
          syncUrl: config.syncUrl,
          roomId: credentials.roomId,
          auth,
          ...(getAuth ? { getAuth } : {}),
          ...(options.webSocketFactory ? { webSocketFactory: options.webSocketFactory } : {}),
          callbacks: {
            onStatus: (status) => {
              if (status === 'live') everLive = true;
              currentStatus = toSessionStatus(status, everLive);
              for (const listener of statusListeners) listener(currentStatus);
              if (!settled && (status === 'live' || status === 'error' || status === 'closed')) {
                settled = true;
                if (status === 'live') resolve(handle);
                else reject(new Error('Opening the collab session failed before it became live.'));
              }
            },
            onRole: (role) => {
              currentRole = role;
              for (const listener of roleListeners) listener(role);
            },
            onError: (error) => {
              if (!settled && error.code === 'unauthorized') {
                settled = true;
                reject(new Error(`Collab session unauthorized: ${error.detail ?? ''}`));
              }
            },
          },
        });

        const handle: RealCollabSessionHandle = {
          get role() { return currentRole; },
          get status() { return currentStatus; },
          onStatusChange: (listener) => {
            statusListeners.add(listener);
            return () => statusListeners.delete(listener);
          },
          onRoleChange: (listener) => {
            roleListeners.add(listener);
            return () => roleListeners.delete(listener);
          },
          close: () => {
            inkSegments().removeRemote(`room:${credentials.roomId}`, segmentClient.remote);
            session.close();
          },
          session,
          viewerStore: createViewerStore(session),
        };
      });
    },
  };
}
