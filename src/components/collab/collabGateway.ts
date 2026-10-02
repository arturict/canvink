/**
 * UI-side contract for notebook sharing, modeled on the "Frontend module
 * contract" section of `services/collab-sync/PROTOCOL.md`. `src/collab/`
 * (owned by another agent) does not exist yet; this file is the seam the
 * integrator will wire a real implementation into. Every component in
 * `src/components/collab/` takes its gateway via a prop typed against this
 * file, never by importing a concrete implementation directly.
 */

export interface CollabConfig {
  /** Worker origin, e.g. `VITE_COLLAB_SYNC_URL`. */
  syncUrl: string;
}

import type { MemberRole, RoomSharing } from '../../collab';

export interface ShareResult {
  roomId: string;
  /** Proves owner role; stored client-side only, never shown to guests. */
  ownerToken: string;
}

export type CollabRole = 'owner' | 'admin' | 'editor' | 'viewer';

/** What the share dialog shows for one notebook, as the room reports it. */
export interface SharingView {
  roomId: string;
  sharing: RoomSharing;
  /** `<app-origin>/app#join=<roomId>.<linkSecret>` while the link is on; reads only. */
  shareUrl: string | null;
  /** `<app-origin>/app#open=<roomId>`: opens the notebook for an invited person; carries no secret. */
  inviteUrl: string;
}

export interface RoomMetaView {
  notebookTitle: string;
  role: CollabRole;
  docCount: number;
}

export type SessionStatus =
  | { kind: 'connecting' }
  | { kind: 'synced' }
  | { kind: 'offline' }
  | { kind: 'reconnecting' }
  | { kind: 'error'; message: string };

export interface OpenSessionCredentials {
  roomId: string;
  /** Present for anonymous viewers and for editors joining via a link. */
  linkSecret?: string;
  /** Present only for the notebook owner, on their own device. */
  ownerToken?: string;
  /** Present once a guest has signed in with Clerk to become an editor. */
  clerkJwt?: string;
  /**
   * Resolves a fresh Clerk JWT for every (re)connect. Clerk session tokens
   * live about a minute, so an editor socket that reconnects (network blip,
   * Worker redeploy, laptop sleep) with the JWT captured at open time is
   * rejected with 4401 and silently stops syncing. Return `null` when the
   * user has signed out; the session then falls back to the link credential.
   */
  getClerkJwt?(): Promise<string | null>;
}

export interface CollabSessionHandle {
  role: CollabRole;
  status: SessionStatus;
  /** Fires whenever the connection status changes (connect/reconnect/error). */
  onStatusChange(listener: (status: SessionStatus) => void): () => void;
  /** Fires once, when a viewer session is upgraded to editor mid-session. */
  onRoleChange(listener: (role: CollabRole) => void): () => void;
  close(): void;
}

export interface CollabGateway {
  /** Whether the notebook is shared already (this device owns the room, or joined it). */
  isShared(notebookId: string): boolean;
  /**
   * Uploads the notebook and creates its room. The room starts restricted: nobody can open it until
   * the owner invites a person or switches the read-only link on.
   */
  createRoomForNotebook(notebookId: string): Promise<ShareResult>;
  /** People, pending invitations and the link of a shared notebook (owner and admins only). */
  loadSharing(notebookId: string): Promise<SharingView>;
  /** Invites a person by e-mail address with a role. Nothing is sent. */
  invite(notebookId: string, email: string, role: MemberRole): Promise<void>;
  revokeInvite(notebookId: string, email: string): Promise<void>;
  changeRole(notebookId: string, sub: string, role: MemberRole): Promise<void>;
  removeMember(notebookId: string, sub: string): Promise<void>;
  /** Turns the read-only link on or off. Off ends the access of everybody who came in through it. */
  setLinkEnabled(notebookId: string, enabled: boolean): Promise<void>;
  /** A new link: the old one and the access that came through it end. */
  regenerateLink(notebookId: string): Promise<void>;
  /**
   * B2: full unshare ("Freigabe beenden") — deletes the room outright,
   * evicting every live collaborator/viewer socket, and forgets the local
   * owner-room record. A no-op if the notebook was never shared.
   */
  unshareNotebook(notebookId: string): Promise<void>;
  /** A member tells the room they leave a notebook that was shared with them (best effort). */
  leaveNotebook(notebookId: string): Promise<void>;
  /** Used by the join screen to show notebook title, role and doc count. */
  fetchMeta(roomId: string, linkSecret: string): Promise<RoomMetaView>;
  /** Connects and starts syncing; never writes into the local workspace. */
  openSession(
    config: CollabConfig,
    credentials: OpenSessionCredentials,
  ): Promise<CollabSessionHandle>;
}

/**
 * Placeholder the integrator replaces once `src/collab/` exists. Every
 * consumer must treat `null` as a first-class, renderable state (hidden or
 * disabled controls), not an error.
 */
export const defaultCollabGateway: CollabGateway | null = null;
