/**
 * Thin client for the collab-sync HTTP API (`/api/v1/...` in PROTOCOL.md).
 */

import type { Role } from './protocol';

export interface CollabHttpConfig {
  /** Worker origin, e.g. `https://collab-sync.example.workers.dev`. */
  syncUrl: string;
  /** App origin used to build share URLs, e.g. `https://canvink.app`. */
  appOrigin: string;
  fetchImpl?: typeof fetch;
}

export interface CreateRoomResult {
  roomId: string;
  ownerToken: string;
}

export interface CreateShareLinkResult {
  linkSecret: string;
  shareUrl: string;
}

export interface RoomMeta {
  notebookTitle: string;
  role: Role;
  docCount: number;
}

/** Credential accepted by `GET /rooms/:roomId/meta`; any valid role credential works. */
export type RoomMetaCredential =
  | { kind: 'owner'; ownerToken: string }
  | { kind: 'link'; linkSecret: string }
  | { kind: 'user'; jwt: string; linkSecret?: string };

function resolveFetch(config: CollabHttpConfig): typeof fetch {
  const impl = config.fetchImpl ?? globalThis.fetch;
  if (!impl) throw new Error('No fetch implementation is available; pass config.fetchImpl.');
  return impl;
}

function apiUrl(config: CollabHttpConfig, path: string): string {
  return `${config.syncUrl.replace(/\/+$/, '')}/api/v1${path}`;
}

async function readErrorDetail(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

async function parseJsonResponse<T>(response: Response, context: string): Promise<T> {
  if (!response.ok) {
    const detail = await readErrorDetail(response);
    throw new Error(`${context} failed with status ${response.status}${detail ? `: ${detail}` : ''}.`);
  }
  return (await response.json()) as T;
}

export async function createRoom(
  config: CollabHttpConfig,
  notebookTitle: string,
): Promise<CreateRoomResult> {
  const fetchImpl = resolveFetch(config);
  const response = await fetchImpl(apiUrl(config, '/rooms'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ notebookTitle }),
  });
  return parseJsonResponse<CreateRoomResult>(response, 'Creating a collab-sync room');
}

export async function createShareLink(
  config: CollabHttpConfig,
  roomId: string,
  ownerToken: string,
): Promise<CreateShareLinkResult> {
  const fetchImpl = resolveFetch(config);
  const response = await fetchImpl(apiUrl(config, `/rooms/${encodeURIComponent(roomId)}/links`), {
    method: 'POST',
    headers: { Authorization: `Owner ${ownerToken}` },
  });
  const { linkSecret } = await parseJsonResponse<{ linkSecret: string }>(
    response,
    'Creating a collab-sync share link',
  );
  return { linkSecret, shareUrl: buildShareUrl(config.appOrigin, roomId, linkSecret) };
}

export async function revokeLinks(
  config: CollabHttpConfig,
  roomId: string,
  ownerToken: string,
): Promise<void> {
  const fetchImpl = resolveFetch(config);
  const response = await fetchImpl(apiUrl(config, `/rooms/${encodeURIComponent(roomId)}/links`), {
    method: 'DELETE',
    headers: { Authorization: `Owner ${ownerToken}` },
  });
  if (!response.ok) {
    const detail = await readErrorDetail(response);
    throw new Error(`Revoking collab-sync share links failed with status ${response.status}${detail ? `: ${detail}` : ''}.`);
  }
}

/** B2: clears every registered collaborator (owner-only); live editor sockets are evicted server-side. */
export async function revokeCollaborators(
  config: CollabHttpConfig,
  roomId: string,
  ownerToken: string,
): Promise<void> {
  const fetchImpl = resolveFetch(config);
  const response = await fetchImpl(apiUrl(config, `/rooms/${encodeURIComponent(roomId)}/collaborators`), {
    method: 'DELETE',
    headers: { Authorization: `Owner ${ownerToken}` },
  });
  if (!response.ok) {
    const detail = await readErrorDetail(response);
    throw new Error(`Revoking collab-sync collaborators failed with status ${response.status}${detail ? `: ${detail}` : ''}.`);
  }
}

/** B2: full unshare — deletes the room outright (owner-only); every live socket is evicted server-side. */
export async function deleteRoom(
  config: CollabHttpConfig,
  roomId: string,
  ownerToken: string,
): Promise<void> {
  const fetchImpl = resolveFetch(config);
  const response = await fetchImpl(apiUrl(config, `/rooms/${encodeURIComponent(roomId)}`), {
    method: 'DELETE',
    headers: { Authorization: `Owner ${ownerToken}` },
  });
  if (!response.ok) {
    const detail = await readErrorDetail(response);
    throw new Error(`Deleting the collab-sync room failed with status ${response.status}${detail ? `: ${detail}` : ''}.`);
  }
}

/** The request headers that carry a room credential. */
export function credentialHeaders(credential: RoomMetaCredential): Record<string, string> {
  const headers: Record<string, string> = {};
  switch (credential.kind) {
    case 'owner':
      headers.Authorization = `Owner ${credential.ownerToken}`;
      break;
    case 'user':
      headers.Authorization = `Bearer ${credential.jwt}`;
      if (credential.linkSecret) headers['X-Link-Secret'] = credential.linkSecret;
      break;
    case 'link':
      // D2: the link secret travels as a header, never a query string —
      // Workers observability logs the request URL (including query
      // params) but not arbitrary request headers.
      headers['X-Link-Secret'] = credential.linkSecret;
      break;
  }
  return headers;
}

export async function fetchRoomMeta(
  config: CollabHttpConfig,
  roomId: string,
  credential: RoomMetaCredential,
): Promise<RoomMeta> {
  const fetchImpl = resolveFetch(config);
  const headers = credentialHeaders(credential);
  const response = await fetchImpl(
    apiUrl(config, `/rooms/${encodeURIComponent(roomId)}/meta`),
    { headers },
  );
  return parseJsonResponse<RoomMeta>(response, 'Fetching collab-sync room metadata');
}

/** `<app-origin>/app#join=<roomId>.<linkSecret>` — the secret never leaves the fragment. */
export function buildShareUrl(appOrigin: string, roomId: string, linkSecret: string): string {
  return `${appOrigin.replace(/\/+$/, '')}/app#join=${roomId}.${linkSecret}`;
}

/** `<app-origin>/app#open=<roomId>`: opens a notebook the signed-in account was invited to. It carries no secret. */
export function buildInviteUrl(appOrigin: string, roomId: string): string {
  return `${appOrigin.replace(/\/+$/, '')}/app#open=${roomId}`;
}

const OPEN_FRAGMENT_PATTERN = /^#?open=([A-Za-z0-9_-]+)$/;

/** Parses a `#open=<roomId>` fragment. Returns null for anything malformed. */
export function parseOpenFragment(hash: string): { roomId: string } | null {
  if (typeof hash !== 'string') return null;
  const match = OPEN_FRAGMENT_PATTERN.exec(hash.trim());
  return match?.[1] ? { roomId: match[1] } : null;
}

const JOIN_FRAGMENT_PATTERN = /^#?join=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;

/** Parses a `#join=<roomId>.<linkSecret>` fragment. Returns null for anything malformed. */
export function parseJoinFragment(hash: string): { roomId: string; linkSecret: string } | null {
  if (typeof hash !== 'string') return null;
  const match = JOIN_FRAGMENT_PATTERN.exec(hash.trim());
  if (!match) return null;
  const [, roomId, linkSecret] = match;
  if (!roomId || !linkSecret) return null;
  return { roomId, linkSecret };
}

// ---- Sharing management (owner and admins) ---------------------------------

/** The role a person is given by name. The owner is implicit and never listed as a member. */
export type MemberRole = 'admin' | 'editor' | 'viewer';

/** Credential of a person who manages sharing: the owner token, or an admin's account token. */
export type ManageCredential =
  | { kind: 'owner'; ownerToken: string }
  | { kind: 'user'; jwt: string };

export interface RoomMember {
  /** The account id; the key of the role and removal routes. */
  sub: string;
  role: MemberRole;
  /** `link`: joined with the read-only link and ends with it; `invite`/`migrated`: a person named by an admin. */
  via: 'invite' | 'link' | 'migrated';
  addedAt: string | null;
  name?: string;
  email?: string;
  picture?: string;
}

export interface RoomInvite {
  email: string;
  role: MemberRole;
  createdAt: string;
  invitedByName?: string;
}

export interface RoomLinkState {
  enabled: boolean;
  /** The secret behind the link; `null` for a room whose links were only stored as hashes. */
  linkSecret: string | null;
}

export interface RoomSharing {
  notebookTitle: string;
  you: { role: Role; sub?: string };
  owner: { name?: string; email?: string; picture?: string };
  members: RoomMember[];
  invites: RoomInvite[];
  link: RoomLinkState;
}

export class CollabHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'CollabHttpError';
  }
}

async function manageRequest<T>(
  config: CollabHttpConfig,
  roomId: string,
  credential: ManageCredential,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const fetchImpl = resolveFetch(config);
  const headers: Record<string, string> = credentialHeaders(credential);
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetchImpl(apiUrl(config, `/rooms/${encodeURIComponent(roomId)}${path}`), {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    let code = 'error';
    try {
      const parsed = (await response.json()) as { error?: unknown };
      if (typeof parsed.error === 'string') code = parsed.error;
    } catch {
      // not JSON
    }
    throw new CollabHttpError(
      response.status,
      code,
      `The collab-sync request ${method} ${path} failed with status ${response.status} (${code}).`,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** Everything the share dialog shows: people, pending invitations and the state of the link. */
export function fetchRoomSharing(config: CollabHttpConfig, roomId: string, credential: ManageCredential): Promise<RoomSharing> {
  return manageRequest<RoomSharing>(config, roomId, credential, 'GET', '/members');
}

/** Invites a person by e-mail address with a role. Nothing is sent; they see it once they sign in. */
export function inviteByEmail(
  config: CollabHttpConfig,
  roomId: string,
  credential: ManageCredential,
  email: string,
  role: MemberRole,
): Promise<RoomInvite> {
  return manageRequest<RoomInvite>(config, roomId, credential, 'POST', '/invites', { email, role });
}

export function revokeInvite(config: CollabHttpConfig, roomId: string, credential: ManageCredential, email: string): Promise<void> {
  return manageRequest<void>(config, roomId, credential, 'DELETE', `/invites/${encodeURIComponent(email)}`);
}

export function changeMemberRole(
  config: CollabHttpConfig,
  roomId: string,
  credential: ManageCredential,
  sub: string,
  role: MemberRole,
): Promise<RoomMember> {
  return manageRequest<RoomMember>(config, roomId, credential, 'PATCH', `/members/${encodeURIComponent(sub)}`, { role });
}

export function removeMember(config: CollabHttpConfig, roomId: string, credential: ManageCredential, sub: string): Promise<void> {
  return manageRequest<void>(config, roomId, credential, 'DELETE', `/members/${encodeURIComponent(sub)}`);
}

/** Turns the read-only link on or off. Off ends the access of everybody who came in through it. */
export function setLinkEnabled(
  config: CollabHttpConfig,
  roomId: string,
  credential: ManageCredential,
  enabled: boolean,
): Promise<RoomLinkState> {
  return manageRequest<RoomLinkState>(config, roomId, credential, 'PUT', '/link', { enabled });
}

/** A new link; the old one stops working, and so does the access of the people who used it. */
export function regenerateLink(config: CollabHttpConfig, roomId: string, credential: ManageCredential): Promise<RoomLinkState> {
  return manageRequest<RoomLinkState>(config, roomId, credential, 'POST', '/link/regenerate');
}

/** A member leaves the shared notebook on their own. */
export function leaveRoom(config: CollabHttpConfig, roomId: string, jwt: string): Promise<void> {
  return manageRequest<void>(config, roomId, { kind: 'user', jwt }, 'POST', '/leave');
}

/** Tells the room who its signed-in owner is (name, address, picture for the member list). */
export function setOwnerProfile(config: CollabHttpConfig, roomId: string, ownerToken: string, jwt: string): Promise<void> {
  return manageRequest<void>(config, roomId, { kind: 'owner', ownerToken }, 'PUT', '/owner-profile', { jwt });
}

/** A notebook someone shared with an address of the signed-in account that was not opened yet. */
export interface Invitation {
  roomId: string;
  notebookTitle: string;
  role: MemberRole;
  invitedBy?: string;
  createdAt: string;
}

export async function listInvitations(config: CollabHttpConfig, jwt: string): Promise<Invitation[]> {
  const fetchImpl = resolveFetch(config);
  const response = await fetchImpl(apiUrl(config, '/me/invitations'), { headers: { Authorization: `Bearer ${jwt}` } });
  const body = await parseJsonResponse<{ invitations: Invitation[] }>(response, 'Listing collab-sync invitations');
  return body.invitations;
}

export async function declineInvitation(config: CollabHttpConfig, jwt: string, roomId: string): Promise<void> {
  const fetchImpl = resolveFetch(config);
  const response = await fetchImpl(apiUrl(config, `/me/invitations/${encodeURIComponent(roomId)}`), {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${jwt}` },
  });
  if (!response.ok) throw new CollabHttpError(response.status, 'error', `Declining the invitation failed with status ${response.status}.`);
}

/** `<app-origin>/app#join=<roomId>.<linkSecret>` for a room the link of which is on. */
export function shareUrlFor(appOrigin: string, roomId: string, link: RoomLinkState): string | null {
  return link.enabled && link.linkSecret ? buildShareUrl(appOrigin, roomId, link.linkSecret) : null;
}
