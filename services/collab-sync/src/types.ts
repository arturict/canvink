// Shared types for the Worker and the NotebookRoom Durable Object.
import type { DeviceAuthEnv } from "./auth/device";
import type { EmailEnv } from "./auth/emails";

/** Cloudflare's Rate Limiting binding surface (see wrangler.jsonc `unsafe.bindings`). */
export interface RateLimiterBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env extends DeviceAuthEnv, EmailEnv {
  NOTEBOOK_ROOM: DurableObjectNamespace;
  ALLOWED_ORIGINS?: string;
  /** B3: per-IP rate limit for POST /rooms. Optional so local dev/tests without the binding still work (in-memory fallback, see src/rateLimit.ts). */
  ROOM_CREATE_RATE_LIMITER?: RateLimiterBinding;
  /** Write-once secret deriving `spaceId` from a Clerk `sub` (PERSONAL-SYNC.md §2.1, §8.1).
   * Every `/me/space*` and `/me/assets/*` route fails closed with 503 when this is unset. */
  PERSONAL_SPACE_SALT?: string;
  /** Personal-space asset storage (PERSONAL-SYNC.md §3.5, §4.2). Optional: the R2 bucket
   * cannot be provisioned yet on this Cloudflare account, so every `/me/assets/*` route
   * must fail closed with `503 {"error":"assets-not-configured"}` while this is undefined.
   * The rest of the personal space (rooms, doc sync, `/me/space`) works without it. */
  ASSETS?: R2Bucket;
}

/** Internal header carrying a verified device id to the space's Durable
 * Object, which refuses the request when that device has been revoked. Only
 * ever set by the Worker on requests it builds itself; client headers never
 * reach the routes that read it. */
export const DEVICE_ID_HEADER = "X-Canvink-Device-Id";

/**
 * What a connection may do in a shared room. `owner` holds the owner token (or is the signed-in
 * account that proved it); `admin` edits and manages sharing; `editor` edits; `viewer` reads
 * ("Lesen"). The role stays server-side authority: a client never states its own.
 */
export type Role = "owner" | "admin" | "editor" | "viewer";

/** The roles a person can be given by name. The owner is implicit and never stored as a member. */
export type MemberRole = "admin" | "editor" | "viewer";

const ROLE_RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };
export function roleRank(role: Role): number {
  return ROLE_RANK[role];
}
export function isMemberRole(value: unknown): value is MemberRole {
  return value === "admin" || value === "editor" || value === "viewer";
}
/** Writes (changes, announces, removals, ink segments) need at least `editor`; anything unknown is denied. */
export function roleCanWrite(role: Role): boolean {
  return role === "owner" || role === "admin" || role === "editor";
}
/** Membership, invitations and the link are managed by the owner and by admins only. */
export function roleCanManage(role: Role): boolean {
  return role === "owner" || role === "admin";
}

/** Discriminates a `NotebookRoom` instance between the sharing surface (`PROTOCOL.md`) and
 * the personal-space surface (`PERSONAL-SYNC.md`). A legacy room with no `kind` row is
 * treated as `"shared"` (PERSONAL-SYNC.md §3.1). */
export type RoomKind = "shared" | "personal";

export interface SocketAttachment {
  role: Role;
  sub?: string;
  /** Unix seconds. Set only on a personal-room socket (PERSONAL-SYNC.md §3.2, §3.4). Its
   * absence means "no expiry gate", i.e. sharing-socket behaviour is unchanged. */
  authExpiresAt?: number;
  /** Random per-connection id, assigned at `hello`. Identifies this socket's presence to the
   * other sockets in the room (`presence` / `presence-leave` frames) without exposing `sub`.
   * Absent on attachments serialized before presence existed. */
  connId?: string;
  /** Name and picture verified from the socket's Clerk token, if it had them. */
  name?: string;
  picture?: string;
  /** Set when a personal socket authenticated with a desktop device token
   * (PERSONAL-SYNC.md §3.7). Revoking that device closes the socket. */
  deviceId?: string;
}

export type HelloAuth =
  | { kind: "owner"; ownerToken: string }
  | { kind: "link"; linkSecret: string }
  | { kind: "user"; jwt: string; linkSecret?: string }
  | { kind: "personal"; jwt: string };

export interface ClientFrameHello {
  t: "hello";
  auth: HelloAuth;
  since?: Record<string, number>;
  /** Personal rooms: replay only what the client cannot do without (workspace and notebook
   * documents). A page document the client holds nothing of (no `since` entry) is left out of the
   * replay; the client asks for it with a `fetch` frame when it needs it. Ignored elsewhere. */
  lazy?: boolean;
}

/** Asks for the current state of documents (snapshot, then the changes after it), the way `hello`
 * replays them, answered by one `fetched` frame naming the documents. `since` carries the seq the
 * client already holds per document, as in `hello`. */
export interface ClientFrameFetch {
  t: "fetch";
  /** Echoed in the `fetched` reply, so several requests can be in flight. */
  id?: string;
  docIds: string[];
  since?: Record<string, number>;
}
export interface ClientFrameAppend {
  t: "append";
  docId: string;
  payload: string;
}
export interface ClientFrameSnapshot {
  t: "snapshot";
  docId: string;
  payload: string;
  covers: number;
}
export interface ClientFrameAnnounce {
  t: "announce";
  docId: string;
  /** `"workspace"` is legal only in a personal room, and only for `docId ===
   * "workspace:root"` (PERSONAL-SYNC.md §3.3). */
  kind: "notebook" | "page" | "workspace";
}
export interface ClientFrameRemove {
  t: "remove";
  docId: string;
}
export interface ClientFramePing {
  t: "ping";
}

/** In-band JWT refresh for a live personal-room socket (PERSONAL-SYNC.md §3.4, P6). Valid
 * only on a socket whose attachment has `role === "owner"` and `authExpiresAt !== undefined`. */
export interface ClientFrameReauth {
  t: "reauth";
  jwt: string;
}

/** Ephemeral presence (cursor, live ink, work region). Relayed to the other sockets, never
 * stored. `state` is opaque to the server apart from its size (PROTOCOL.md "Presence"). */
export interface ClientFramePresence {
  t: "presence";
  state: Record<string, unknown>;
}

export type ClientFrame =
  | ClientFramePresence
  | ClientFrameHello
  | ClientFrameFetch
  | ClientFrameAppend
  | ClientFrameSnapshot
  | ClientFrameAnnounce
  | ClientFrameRemove
  | ClientFramePing
  | ClientFrameReauth;

/** Server→sender ack for an accepted `append`, used by the client to drive periodic compaction. */
export interface ServerFrameSeqAck {
  t: "seq";
  docId: string;
  seq: number;
}

/** Server→sender ack for an accepted `reauth` frame (PERSONAL-SYNC.md §3.4). */
export interface ServerFrameReauthed {
  t: "reauthed";
  expiresAt: number;
}

/** Server-to-socket push when the connection's role changed while it was open. */
export interface ServerFrameRole {
  t: "role";
  role: Role;
}

export type ErrorCode =
  | "read-only"
  | "unauthorized"
  | "payload-too-large"
  | "unknown-doc"
  | "bad-frame"
  | "quota-exceeded";

/** One WebSocket frame. Large enough for a heavy page's snapshot (about 10 MiB raw once base64 is
 * counted); Cloudflare allows 32 MiB per message and the Durable Object has 128 MB of memory. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
/** Serialized size ceiling for one presence `state` (PROTOCOL.md "Presence"). */
export const MAX_PRESENCE_STATE_BYTES = 16 * 1024;
/** Per-socket presence budget: bucket size and refill per second. A client sends at most
 * ~30 frames per second while drawing; excess frames are dropped silently. */
export const PRESENCE_BURST = 60;
export const PRESENCE_REFILL_PER_SECOND = 40;
/** Documents one `fetch` frame may ask for. */
export const MAX_FETCH_DOCS = 64;
export const MAX_DOC_LOG_BYTES = 50 * 1024 * 1024;

/** Pending invitations by e-mail per room. */
export const MAX_INVITES_PER_ROOM = 100;

/** Docs per personal room (PERSONAL-SYNC.md §7). Personal-room-only; shared rooms keep their
 * existing 1 000-doc limit (enforced elsewhere, unchanged). */
export const MAX_DOCS_PER_SPACE = 5_000;
/** Total change-log bytes per personal space, tracked via the `meta.logBytes` counter
 * (PERSONAL-SYNC.md §3.6, §7). */
export const MAX_SPACE_LOG_BYTES = 1 * 1024 * 1024 * 1024;
/** Single asset object size ceiling, matching the native base64 decode cap
 * (PERSONAL-SYNC.md §7). */
export const MAX_ASSET_BYTES = 64 * 1024 * 1024;
/** Total asset bytes per personal space, tracked via the `meta.assetBytes` counter
 * (PERSONAL-SYNC.md §7). */
export const SPACE_ASSET_QUOTA_BYTES = 2 * 1024 * 1024 * 1024;

/** Ink segments of one shared room: one object at most this large, and this much in total. */
export const MAX_ROOM_ASSET_BYTES = 16 * 1024 * 1024;
export const ROOM_ASSET_QUOTA_BYTES = 512 * 1024 * 1024;
