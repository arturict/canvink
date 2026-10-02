// NotebookRoom: one SQLite-backed Durable Object per shared notebook.
// Implements the HTTP management routes and the WebSocket sync protocol
// exactly per PROTOCOL.md. Uses the WebSocket Hibernation API so an idle
// room's DO instance can be evicted between messages at no cost.
import { DEVICE_CODE_TTL_SECONDS, s256, verifySpaceToken, type SpaceIdentity } from "./auth/device";
import { MAX_EMAIL_LENGTH, normalizeEmail, verifiedEmailsFor } from "./auth/emails";
import type { InboxEntry } from "./inbox";
import { inboxDelete, inboxPut } from "./inbox";
import { deriveSpaceId } from "./space";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  constantTimeEqual,
  generateLinkSecret,
  generateOwnerToken,
  randomBase64Url,
  sha256Hex,
} from "./util/crypto";
import type {
  ClientFrameAnnounce,
  ClientFrameAppend,
  ClientFrameFetch,
  ClientFrameHello,
  ClientFramePresence,
  ClientFrameReauth,
  ClientFrameRemove,
  ClientFrameSnapshot,
  Env,
  ErrorCode,
  HelloAuth,
  MemberRole,
  Role,
  RoomKind,
  SocketAttachment,
} from "./types";
import {
  DEVICE_ID_HEADER,
  MAX_INVITES_PER_ROOM,
  isMemberRole,
  roleCanManage,
  roleCanWrite,
  roleRank,
  MAX_ASSET_BYTES,
  MAX_DOC_LOG_BYTES,
  MAX_DOCS_PER_SPACE,
  MAX_FETCH_DOCS,
  MAX_FRAME_BYTES,
  MAX_PRESENCE_STATE_BYTES,
  MAX_SPACE_LOG_BYTES,
  PRESENCE_BURST,
  PRESENCE_REFILL_PER_SECOND,
  SPACE_ASSET_QUOTA_BYTES,
  MAX_ROOM_ASSET_BYTES,
  ROOM_ASSET_QUOTA_BYTES,
} from "./types";

/** PERSONAL-SYNC.md §3.4, §7: a personal socket's write gate. */
const AUTH_EXPIRY_GRACE_SECONDS = 120;
/** PERSONAL-SYNC.md §3.3: the one legal `kind:"workspace"` docId. */
const WORKSPACE_ROOT_DOC_ID = "workspace:root";

// ---- Desktop devices (PERSONAL-SYNC.md §3.7) -------------------------
const MAX_DEVICES_PER_SPACE = 20;
/** A device that has not refreshed for this long is signed out. */
const DEVICE_IDLE_EXPIRY_MS = 90 * 24 * 60 * 60 * 1000;
/** A retry with the just-rotated refresh token inside this window (a lost
 * response) rotates again; later, the same token counts as reuse and signs
 * the device out. */
const REFRESH_REUSE_LEEWAY_MS = 30_000;
const MAX_DEVICE_LABEL_LENGTH = 60;

interface DeviceRow {
  deviceId: string;
  label: string;
  refreshHash: string;
  prevRefreshHash: string | null;
  rotatedAt: number;
  name: string | null;
  picture: string | null;
  createdAt: number;
  lastUsedAt: number;
  /** Random id the app keeps across sign-ins; a new sign-in of the same installation replaces its older device row. */
  installId: string | null;
  platform: string | null;
  appVersion: string | null;
}

interface DeviceCodeRow {
  codeHash: string;
  challenge: string;
  name: string | null;
  picture: string | null;
  expiresAt: number;
  usedAt: number | null;
  deviceId: string | null;
}

/** Device names come from the app; keep them short and printable. */
function sanitizeDeviceLabel(value: unknown): string {
  const text = typeof value === "string"
    ? Array.from(value).filter((ch) => ch >= " " && ch !== "\u007f").join("").trim()
    : "";
  return text.slice(0, MAX_DEVICE_LABEL_LENGTH) || "Canvink Desktop";
}

const DEVICE_PLATFORMS = new Set(["windows", "macos", "linux", "android", "ios"]);
const INSTALL_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const APP_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,23}$/;

/** What the app says about itself at sign-in; every field is optional and checked. */
interface DeviceClientInfo {
  installId: string | null;
  platform: string | null;
  appVersion: string | null;
}

function sanitizeClientInfo(body: Record<string, unknown>): DeviceClientInfo {
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  const platform = text(body.platform).toLowerCase();
  return {
    installId: INSTALL_ID_PATTERN.test(text(body.installId)) ? text(body.installId) : null,
    platform: DEVICE_PLATFORMS.has(platform) ? platform : null,
    appVersion: APP_VERSION_PATTERN.test(text(body.appVersion)) ? text(body.appVersion) : null,
  };
}

/** How an account got in: invited by name, through the read-only link, or carried over from before roles. */
type MemberVia = "invite" | "link" | "migrated";

interface MemberRow {
  sub: string;
  role: string | null;
  via: string | null;
  addedAt: string | null;
  name: string | null;
  email: string | null;
  /** JSON array of the verified addresses seen at the last refresh. */
  emails: string | null;
  picture: string | null;
}

/** Who calls an HTTP route. `sub` and `name` are set for accounts. */
interface Principal {
  role: Role;
  sub?: string;
  name?: string;
}

interface DocRow {
  docId: string;
  kind: string;
  snapshot: ArrayBuffer | null;
  covers: number;
}

// ---- Limits (B3) -----------------------------------------------------
const MAX_NOTEBOOK_TITLE_LENGTH = 200;
const MAX_DOCS_PER_ROOM = 1000;
/** Largest payload kept in one SQLite cell (a Durable Object row is capped at 2 MB). */
const INLINE_BLOB_MAX = 1_000_000;
/** Cell value that stands in for a payload stored in `chunks`: 4 prefix bytes, then the big-endian total length. */
const CHUNK_MARKER_PREFIX = new Uint8Array([0xff, 0xc4, 0x4e, 0x4b]);
const CHUNK_MARKER_LENGTH = 8;

function isChunkMarker(cell: Uint8Array): boolean {
  return cell.byteLength === CHUNK_MARKER_LENGTH && CHUNK_MARKER_PREFIX.every((byte, i) => cell[i] === byte);
}
const MAX_LINKS_PER_ROOM = 20;
const MAX_COLLABORATORS_PER_ROOM = 100;

// ---- Frame validation (D6) --------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  // B3 punch-list: `typeof [] === "object"` — without excluding arrays, a
  // JSON array body/frame passes every `isRecord` check here, and any field
  // this function doesn't explicitly require (e.g. `notebookTitle` on
  // `POST /rooms`, which is optional) is simply `undefined` on an array too,
  // silently skipping its validation instead of failing it.
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Unpadded base64url alphabet only; rejects `+`, `/`, `=`, and other garbage early. */
function isValidBase64Url(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]*$/.test(value);
}

function isValidHelloAuth(auth: unknown): auth is HelloAuth {
  if (!isRecord(auth)) return false;
  if (auth.kind === "owner") return typeof auth.ownerToken === "string";
  if (auth.kind === "link") return typeof auth.linkSecret === "string";
  if (auth.kind === "user") {
    return (
      typeof auth.jwt === "string" &&
      (auth.linkSecret === undefined || typeof auth.linkSecret === "string")
    );
  }
  if (auth.kind === "personal") return typeof auth.jwt === "string";
  return false;
}

function isValidSince(since: unknown): since is Record<string, number> | undefined {
  if (since === undefined) return true;
  if (!isRecord(since)) return false;
  return Object.values(since).every((v) => typeof v === "number" && Number.isFinite(v));
}

function isValidHelloFrame(frame: Record<string, unknown>): frame is ClientFrameHello & Record<string, unknown> {
  return isValidHelloAuth(frame.auth) && isValidSince(frame.since)
    && (frame.lazy === undefined || typeof frame.lazy === "boolean");
}

function isValidFetchFrame(frame: Record<string, unknown>): frame is ClientFrameFetch & Record<string, unknown> {
  return (
    Array.isArray(frame.docIds) &&
    frame.docIds.length <= MAX_FETCH_DOCS &&
    frame.docIds.every((docId) => typeof docId === "string") &&
    isValidSince(frame.since) &&
    (frame.id === undefined || (typeof frame.id === "string" && frame.id.length <= 64))
  );
}

function isValidAppendFrame(frame: Record<string, unknown>): frame is ClientFrameAppend & Record<string, unknown> {
  return typeof frame.docId === "string" && isValidBase64Url(frame.payload);
}

function isValidSnapshotFrame(frame: Record<string, unknown>): frame is ClientFrameSnapshot & Record<string, unknown> {
  return (
    typeof frame.docId === "string" &&
    isValidBase64Url(frame.payload) &&
    typeof frame.covers === "number" &&
    Number.isFinite(frame.covers)
  );
}

function isValidAnnounceFrame(frame: Record<string, unknown>): frame is ClientFrameAnnounce & Record<string, unknown> {
  return (
    typeof frame.docId === "string" &&
    (frame.kind === "notebook" || frame.kind === "page" || frame.kind === "workspace")
  );
}

function isValidRemoveFrame(frame: Record<string, unknown>): frame is ClientFrameRemove & Record<string, unknown> {
  return typeof frame.docId === "string";
}

function isValidReauthFrame(frame: Record<string, unknown>): frame is ClientFrameReauth & Record<string, unknown> {
  return typeof frame.jwt === "string";
}

function isValidPresenceFrame(frame: Record<string, unknown>): frame is ClientFramePresence & Record<string, unknown> {
  return isRecord(frame.state) && !Array.isArray(frame.state);
}

export class NotebookRoom implements DurableObject {
  private readonly sql: SqlStorage;
  private ready: Promise<void>;
  /** Best-effort, per-isolate reauth throttle (§7); reset on hibernation, same
   * caveat as the other in-memory rate limiters in this repo. */
  private readonly reauthTimestamps = new WeakMap<WebSocket, number>();
  /** Last relayed presence frame per `connId`, replayed to a socket that joins later. In
   * memory only: presence is ephemeral, and after hibernation the clients' own heartbeat
   * (every few seconds) refills it. */
  private readonly lastPresence = new Map<string, string>();
  /** Per-socket token bucket for presence frames; same best-effort caveat as above. */
  private readonly presenceBudget = new WeakMap<WebSocket, { tokens: number; at: number }>();

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {
    this.sql = ctx.storage.sql;
    this.ready = this.ctx.blockConcurrencyWhile(async () => this.ensureSchema());
  }

  /** `SqlStorageCursor#one()` throws on zero rows; use this when zero is valid. */
  private maybeOne<T extends Record<string, SqlStorageValue>>(
    cursor: SqlStorageCursor<T>,
  ): T | undefined {
    return cursor.toArray()[0];
  }

  /**
   * Collaborators used to be plain editors (`sub`, `addedAt`). Each now carries a role and how they
   * got in: `via` is `invite` (named by an admin or by e-mail), `link` (joined with the read-only
   * link; revoked when the link is turned off) or `migrated` (an editor from before roles existed;
   * they keep Bearbeiten and are not affected by the link). Idempotent: runs on every wake.
   */
  private migrateCollaborators(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS collaborators (sub TEXT PRIMARY KEY, addedAt TEXT)`);
    const columns = new Set(
      this.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('collaborators')").toArray().map((row) => row.name),
    );
    for (const column of ["role", "via", "name", "email", "emails", "picture"]) {
      if (!columns.has(column)) this.sql.exec(`ALTER TABLE collaborators ADD COLUMN ${column} TEXT`);
    }
    this.sql.exec("UPDATE collaborators SET role = 'editor', via = 'migrated' WHERE role IS NULL");
  }

  private ensureSchema(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS links (secretHash TEXT PRIMARY KEY, createdAt TEXT)`);
    this.migrateCollaborators();
    // Invitations by e-mail that nobody has claimed yet (PROTOCOL.md "Sharing roles").
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS invites (email TEXT PRIMARY KEY, role TEXT NOT NULL, invitedBySub TEXT, invitedByName TEXT, createdAt TEXT NOT NULL)`,
    );
    // Inbox Durable Objects only: the rooms that invited this address.
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS inbox (roomId TEXT PRIMARY KEY, notebookTitle TEXT NOT NULL, role TEXT NOT NULL, invitedBy TEXT, createdAt TEXT NOT NULL)`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS docs (docId TEXT PRIMARY KEY, kind TEXT, snapshot BLOB, covers INTEGER DEFAULT 0)`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS chunks (docId TEXT NOT NULL, seq INTEGER NOT NULL, idx INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (docId, seq, idx))`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS changes (docId TEXT, seq INTEGER, payload BLOB, PRIMARY KEY (docId, seq))`,
    );
    // PERSONAL-SYNC.md §3.7: desktop login codes and signed-in devices. Only
    // personal rooms ever write rows here. Secrets are stored as SHA-256 hashes.
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS device_codes (codeHash TEXT PRIMARY KEY, challenge TEXT NOT NULL, name TEXT, picture TEXT, expiresAt INTEGER NOT NULL, usedAt INTEGER, deviceId TEXT)`,
    );
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS devices (deviceId TEXT PRIMARY KEY, label TEXT NOT NULL, refreshHash TEXT NOT NULL, prevRefreshHash TEXT, rotatedAt INTEGER NOT NULL, name TEXT, picture TEXT, createdAt INTEGER NOT NULL, lastUsedAt INTEGER NOT NULL)`,
    );
    // Added with the account page: which installation, platform and app
    // version a device is. Rows from before have NULLs.
    const deviceColumns = new Set(
      this.sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('devices')").toArray().map((row) => row.name),
    );
    for (const column of ["installId", "platform", "appVersion"]) {
      if (!deviceColumns.has(column)) this.sql.exec(`ALTER TABLE devices ADD COLUMN ${column} TEXT`);
    }
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    const url = new URL(request.url);
    this.rememberRoomId(request);

    if (url.pathname === "/init" && request.method === "POST") {
      return this.handleInit(request);
    }
    if (url.pathname === "/links" && request.method === "POST") {
      return this.handleCreateLink(request);
    }
    if (url.pathname === "/links" && request.method === "DELETE") {
      return this.handleRevokeLinks(request);
    }
    if (url.pathname === "/collaborators" && request.method === "DELETE") {
      return this.handleClearCollaborators(request);
    }
    if (url.pathname === "/meta" && request.method === "GET") {
      return this.handleMeta(request);
    }
    if (url.pathname === "/members" && request.method === "GET") {
      return this.handleListMembers(request);
    }
    if (url.pathname.startsWith("/members/")) {
      const sub = safeDecode(url.pathname.slice("/members/".length));
      if (sub === null) return Response.json({ error: "bad-request" }, { status: 400 });
      if (request.method === "PATCH") return this.handleChangeMemberRole(request, sub);
      if (request.method === "DELETE") return this.handleRemoveMember(request, sub);
    }
    if (url.pathname === "/invites" && request.method === "POST") {
      return this.handleCreateInvite(request);
    }
    if (url.pathname.startsWith("/invites/") && request.method === "DELETE") {
      const email = safeDecode(url.pathname.slice("/invites/".length));
      if (email === null) return Response.json({ error: "bad-request" }, { status: 400 });
      return this.handleRevokeInvite(request, email);
    }
    if (url.pathname === "/invites/decline" && request.method === "POST") {
      return this.handleDeclineInvites(request);
    }
    if (url.pathname === "/link" && request.method === "GET") {
      return this.handleGetLink(request);
    }
    if (url.pathname === "/link" && request.method === "PUT") {
      return this.handleSetLink(request);
    }
    if (url.pathname === "/link/regenerate" && request.method === "POST") {
      return this.handleRegenerateLink(request);
    }
    if (url.pathname === "/leave" && request.method === "POST") {
      return this.handleLeave(request);
    }
    if (url.pathname === "/owner-profile" && request.method === "PUT") {
      return this.handleOwnerProfile(request);
    }
    if (url.pathname === "/inbox/put" && request.method === "POST") {
      return this.handleInboxPut(request);
    }
    if (url.pathname === "/inbox/delete" && request.method === "POST") {
      return this.handleInboxDelete(request);
    }
    if (url.pathname === "/inbox/list" && request.method === "GET") {
      return this.handleInboxList();
    }
    if (url.pathname === "/ws" && request.method === "GET") {
      return this.handleWebSocketUpgrade(request);
    }
    if (url.pathname.startsWith("/room-assets/")) {
      if (request.method === "HEAD" || request.method === "GET" || request.method === "PUT") {
        return this.handleRoomAsset(request, url.pathname.slice("/room-assets/".length));
      }
    }
    if (url.pathname === "/" && request.method === "DELETE") {
      return this.handleDeleteRoom(request);
    }
    if (url.pathname === "/device/code" && request.method === "POST") {
      return this.handleDeviceCode(request);
    }
    if (url.pathname === "/device/code/status" && request.method === "POST") {
      return this.handleDeviceCodeStatus(request);
    }
    if (url.pathname === "/device/token" && request.method === "POST") {
      return this.handleDeviceToken(request);
    }
    if (url.pathname === "/devices" && request.method === "GET") {
      return this.handleDeviceList();
    }
    if (url.pathname.startsWith("/devices/active/") && request.method === "GET") {
      const deviceId = url.pathname.slice("/devices/active/".length);
      return new Response(null, { status: this.isPersonalRoom() && this.deviceActive(deviceId) ? 204 : 404 });
    }
    if (url.pathname.startsWith("/devices/") && request.method === "PATCH") {
      return this.handleDeviceRename(url.pathname.slice("/devices/".length), request);
    }
    if (url.pathname.startsWith("/devices/") && request.method === "DELETE") {
      return this.handleDeviceRevoke(url.pathname.slice("/devices/".length));
    }
    // Personal routes the Worker reaches with a device token carry the
    // verified device id; a revoked or expired device is refused here.
    const requestDeviceId = request.headers.get(DEVICE_ID_HEADER);
    if (requestDeviceId !== null && !this.deviceActive(requestDeviceId)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    if (url.pathname === "/space/init" && request.method === "POST") {
      return this.handleSpaceInit(request);
    }
    if (url.pathname === "/space" && request.method === "GET") {
      return this.handleSpaceGet();
    }
    if (url.pathname.startsWith("/assets/")) {
      const hexPart = url.pathname.slice("/assets/".length);
      if (
        request.method === "HEAD" ||
        request.method === "GET" ||
        request.method === "PUT" ||
        request.method === "DELETE"
      ) {
        return this.handleAsset(request, hexPart);
      }
    }
    return new Response("not found", { status: 404 });
  }

  /**
   * A room does not know its own id (the Durable Object is addressed by it), but the inbox index
   * needs it. The Worker sets `X-Room-Id` from the URL on every room route, overwriting whatever
   * the client sent, so the first request that carries it records it.
   */
  private rememberRoomId(request: Request): void {
    const roomId = request.headers.get("X-Room-Id");
    if (!roomId || !/^[A-Za-z0-9_-]{1,64}$/.test(roomId)) return;
    if (this.getMetaValue("roomId") !== null) return;
    if (this.getMetaValue("ownerTokenHash") === null || this.getRoomKind() !== "shared") return;
    this.setMetaValue("roomId", roomId);
  }

  // ---- meta helpers -------------------------------------------------

  private getMetaValue(key: string): string | null {
    const row = this.maybeOne(
      this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key),
    );
    return row?.value ?? null;
  }

  private setMetaValue(key: string, value: string): void {
    this.sql.exec(
      `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      value,
    );
  }

  /** PERSONAL-SYNC.md §3.1: a room exists once it has either an owner-token
   * hash (shared) or a `personalSub` (personal). */
  private roomExists(): boolean {
    return this.getMetaValue("ownerTokenHash") !== null || this.getMetaValue("personalSub") !== null;
  }

  /** A legacy room with no `kind` row is treated as `"shared"` (PERSONAL-SYNC.md §3.1). */
  private getRoomKind(): RoomKind {
    return this.getMetaValue("kind") === "personal" ? "personal" : "shared";
  }

  /** PERSONAL-SYNC.md §3.6: O(1) quota check via a counter, recomputed lazily
   * (a full `SUM`) if the row is missing. Personal rooms only. */
  private getLogBytes(): number {
    const raw = this.getMetaValue("logBytes");
    if (raw !== null) return Number(raw);
    const row = this.sql
      .exec(
        `SELECT
           COALESCE((SELECT SUM(LENGTH(snapshot)) FROM docs WHERE snapshot IS NOT NULL), 0) +
           COALESCE((SELECT SUM(LENGTH(payload)) FROM changes), 0) +
           COALESCE((SELECT SUM(LENGTH(data)) FROM chunks), 0) AS n`,
      )
      .one() as { n: number };
    this.setMetaValue("logBytes", String(row.n));
    return row.n;
  }

  private adjustLogBytes(delta: number): void {
    const next = Math.max(0, this.getLogBytes() + delta);
    this.setMetaValue("logBytes", String(next));
  }

  // ---- large payload storage ----------------------------------------
  // A Durable Object SQLite row holds at most 2 MB, but a heavy page's
  // Automerge snapshot (or one big change) can be several MB. A payload over
  // INLINE_BLOB_MAX is split into `chunks` rows (seq 0 = the doc snapshot,
  // seq > 0 = the change with that seq) and the `docs.snapshot` /
  // `changes.payload` cell keeps an 8-byte marker instead. Payloads at or
  // below the threshold stay inline, so existing rows keep working untouched.

  /** Bytes a payload of `length` occupies in storage, counted for quotas. */
  private storedCost(length: number): number {
    return length > INLINE_BLOB_MAX ? CHUNK_MARKER_LENGTH + length : length;
  }

  /** Writes the payload and returns the value for the owning row's cell. */
  private storePayload(docId: string, seq: number, bytes: Uint8Array): Uint8Array {
    this.sql.exec("DELETE FROM chunks WHERE docId = ? AND seq = ?", docId, seq);
    if (bytes.byteLength <= INLINE_BLOB_MAX) return bytes;
    let idx = 0;
    for (let offset = 0; offset < bytes.byteLength; offset += INLINE_BLOB_MAX) {
      this.sql.exec(
        "INSERT INTO chunks (docId, seq, idx, data) VALUES (?, ?, ?, ?)",
        docId,
        seq,
        idx,
        bytes.subarray(offset, offset + INLINE_BLOB_MAX),
      );
      idx += 1;
    }
    const marker = new Uint8Array(CHUNK_MARKER_LENGTH);
    marker.set(CHUNK_MARKER_PREFIX, 0);
    new DataView(marker.buffer).setUint32(4, bytes.byteLength);
    return marker;
  }

  /** Reads a payload back from its row cell, reassembling chunks when needed. */
  private loadPayload(docId: string, seq: number, cell: ArrayBuffer): Uint8Array {
    const inline = new Uint8Array(cell);
    if (!isChunkMarker(inline)) return inline;
    const total = new DataView(inline.buffer, inline.byteOffset).getUint32(4);
    const out = new Uint8Array(total);
    let offset = 0;
    const rows = this.sql.exec<{ data: ArrayBuffer }>(
      "SELECT data FROM chunks WHERE docId = ? AND seq = ? ORDER BY idx ASC",
      docId,
      seq,
    );
    for (const row of rows) {
      const part = new Uint8Array(row.data);
      out.set(part, offset);
      offset += part.byteLength;
    }
    return out;
  }

  /** Stored bytes of a doc's snapshot, or of its changes with seq <= `maxSeq`. */
  private snapshotBytes(docId: string): number {
    const row = this.sql
      .exec(
        `SELECT COALESCE((SELECT LENGTH(snapshot) FROM docs WHERE docId = ?), 0) +
                COALESCE((SELECT SUM(LENGTH(data)) FROM chunks WHERE docId = ? AND seq = 0), 0) AS n`,
        docId,
        docId,
      )
      .one() as { n: number };
    return row.n;
  }

  private changesBytes(docId: string, maxSeq = Number.MAX_SAFE_INTEGER): number {
    const row = this.sql
      .exec(
        `SELECT COALESCE((SELECT SUM(LENGTH(payload)) FROM changes WHERE docId = ? AND seq <= ?), 0) +
                COALESCE((SELECT SUM(LENGTH(data)) FROM chunks WHERE docId = ? AND seq > 0 AND seq <= ?), 0) AS n`,
        docId,
        maxSeq,
        docId,
        maxSeq,
      )
      .one() as { n: number };
    return row.n;
  }

  private deleteChangesThrough(docId: string, covers: number): void {
    this.sql.exec("DELETE FROM changes WHERE docId = ? AND seq <= ?", docId, covers);
    this.sql.exec("DELETE FROM chunks WHERE docId = ? AND seq > 0 AND seq <= ?", docId, covers);
  }

  private async handleInit(request: Request): Promise<Response> {
    if (this.roomExists()) {
      // idempotency guard: a room's DO id is derived from roomId, which the
      // worker only mints once, so a second /init would indicate a bug or
      // a roomId collision retry — refuse rather than silently re-minting.
      return Response.json({ error: "already-initialized" }, { status: 409 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "invalid-body" }, { status: 400 });
    }
    if (!isRecord(body)) {
      return Response.json({ error: "invalid-body" }, { status: 400 });
    }
    const rawTitle = body.notebookTitle;
    if (rawTitle !== undefined && typeof rawTitle !== "string") {
      return Response.json({ error: "invalid-notebook-title" }, { status: 400 });
    }
    const notebookTitle = rawTitle ?? "Untitled notebook";
    if (notebookTitle.length > MAX_NOTEBOOK_TITLE_LENGTH) {
      return Response.json({ error: "notebook-title-too-long" }, { status: 400 });
    }

    const ownerToken = generateOwnerToken();
    const ownerTokenHash = await sha256Hex(ownerToken);
    const createdAt = new Date().toISOString();

    // A new room starts restricted: nobody gets in by link until an admin switches the link on.
    this.sql.exec(
      "INSERT INTO meta (key, value) VALUES (?, ?), (?, ?), (?, ?), (?, ?), (?, ?)",
      "kind",
      "shared",
      "notebookTitle",
      notebookTitle,
      "ownerTokenHash",
      ownerTokenHash,
      "createdAt",
      createdAt,
      "linkEnabled",
      "0",
    );
    this.rememberRoomId(request);

    return Response.json({ ownerToken }, { status: 201 });
  }

  private async verifyOwnerHeader(request: Request): Promise<boolean> {
    const auth = request.headers.get("Authorization") ?? "";
    const match = /^Owner (.+)$/.exec(auth);
    if (!match) return false;
    const ownerTokenHash = this.getMetaValue("ownerTokenHash");
    if (!ownerTokenHash) return false;
    const providedHash = await sha256Hex(match[1] as string);
    return constantTimeEqual(providedHash, ownerTokenHash);
  }

  private linkCount(): number {
    const row = this.sql.exec("SELECT COUNT(*) AS n FROM links").one() as { n: number };
    return row.n;
  }

  /** PERSONAL-SYNC.md §3.1: cross-kind refusal — a personal space can never
   * be link-shared, have its collaborators cleared, or be deleted by a
   * bearer/owner token. */
  private refuseIfPersonal(): Response | null {
    if (this.getRoomKind() === "personal") {
      return Response.json({ error: "not-a-shared-room" }, { status: 403 });
    }
    return null;
  }

  // ---- Principals and roles (PROTOCOL.md "Sharing roles") ---------------------------------

  /** The account that proved ownership of the room, if the owner signed in (`PUT /owner-profile`). */
  private getOwnerSub(): string | null {
    return this.getMetaValue("ownerSub");
  }

  private getMember(sub: string): MemberRow | undefined {
    return this.maybeOne(
      this.sql.exec<MemberRow & Record<string, SqlStorageValue>>(
        "SELECT sub, role, via, addedAt, name, email, emails, picture FROM collaborators WHERE sub = ?",
        sub,
      ),
    );
  }

  /** A stored role that is not one of the three is treated as the least privilege. */
  private memberRole(row: MemberRow): MemberRole {
    return isMemberRole(row.role) ? row.role : "viewer";
  }

  private inviteCount(): number {
    const row = this.sql.exec("SELECT COUNT(*) AS n FROM invites").one() as { n: number };
    return row.n;
  }

  /** Link sharing is on when it was switched on; a room from before the switch existed is on while it has a link. */
  private linkEnabled(): boolean {
    const flag = this.getMetaValue("linkEnabled");
    return flag === null ? this.linkCount() > 0 : flag === "1";
  }

  private async linkSecretIsValid(linkSecret: string): Promise<boolean> {
    if (!this.linkEnabled()) return false;
    const hash = await sha256Hex(linkSecret);
    const row = this.maybeOne(
      this.sql.exec<{ found: number }>(
        "SELECT 1 AS found FROM links WHERE secretHash = ?",
        hash,
      ),
    );
    return row !== undefined;
  }

  private collaboratorCount(): number {
    const row = this.sql.exec("SELECT COUNT(*) AS n FROM collaborators").one() as { n: number };
    return row.n;
  }

  private insertMember(
    identity: Pick<SpaceIdentity, "sub" | "name" | "picture">,
    role: MemberRole,
    via: MemberVia,
    emails: readonly string[],
  ): MemberRow {
    const row: MemberRow = {
      sub: identity.sub,
      role,
      via,
      addedAt: new Date().toISOString(),
      name: identity.name ?? null,
      email: emails[0] ?? null,
      emails: emails.length > 0 ? JSON.stringify(emails) : null,
      picture: identity.picture ?? null,
    };
    this.sql.exec(
      `INSERT INTO collaborators (sub, addedAt, role, via, name, email, emails, picture) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(sub) DO UPDATE SET role = excluded.role, via = excluded.via`,
      row.sub,
      row.addedAt,
      row.role,
      row.via,
      row.name,
      row.email,
      row.emails,
      row.picture,
    );
    return row;
  }

  /**
   * Turns pending e-mail invitations into membership when the account owns a verified address that
   * was invited. A member who was only a link reader becomes a named member with the invited role;
   * a higher existing role is never lowered by an invitation.
   */
  private async applyPendingInvites(
    identity: SpaceIdentity,
    member: MemberRow | undefined,
  ): Promise<MemberRow | undefined> {
    if (this.inviteCount() === 0) return member;
    const emails = await verifiedEmailsFor(identity, this.env);
    if (emails.length === 0) return member;
    const matched = this.sql
      .exec<{ email: string; role: string }>(
        `SELECT email, role FROM invites WHERE email IN (${emails.map(() => "?").join(",")})`,
        ...emails,
      )
      .toArray();
    if (matched.length === 0) return member;

    let invited: MemberRole = "viewer";
    for (const row of matched) {
      if (isMemberRole(row.role) && roleRank(row.role) > roleRank(invited)) invited = row.role;
    }
    let result: MemberRow;
    if (member) {
      const current = this.memberRole(member);
      const role = roleRank(invited) > roleRank(current) ? invited : current;
      this.sql.exec("UPDATE collaborators SET role = ?, via = 'invite' WHERE sub = ?", role, member.sub);
      result = { ...member, role, via: "invite" };
    } else if (this.collaboratorCount() < MAX_COLLABORATORS_PER_ROOM) {
      result = this.insertMember(identity, invited, "invite", emails);
    } else {
      return member;
    }
    for (const { email } of matched) {
      this.sql.exec("DELETE FROM invites WHERE email = ?", email);
      await this.inboxRemove(email);
    }
    return result;
  }

  /** Name, picture and verified addresses of a member follow their account. */
  private async refreshMemberProfile(identity: SpaceIdentity, member: MemberRow): Promise<MemberRow> {
    let next = member;
    if (
      (identity.name && identity.name !== member.name)
      || (identity.picture && identity.picture !== member.picture)
    ) {
      next = { ...next, name: identity.name ?? member.name, picture: identity.picture ?? member.picture };
      this.sql.exec("UPDATE collaborators SET name = ?, picture = ? WHERE sub = ?", next.name, next.picture, member.sub);
    }
    if (member.emails === null) {
      const emails = await verifiedEmailsFor(identity, this.env);
      if (emails.length > 0) {
        next = { ...next, email: emails[0] ?? null, emails: JSON.stringify(emails) };
        this.sql.exec("UPDATE collaborators SET email = ?, emails = ? WHERE sub = ?", next.email, next.emails, member.sub);
      }
    }
    return next;
  }

  /**
   * What a signed-in account is in this room, decided here and nowhere else: the owner (an account
   * that proved ownership), a member by name (invitation by e-mail or added by an admin), or, with a
   * valid link, a registered reader. The role of a link join is always `viewer`, whatever the client
   * asked for. `null` means no access.
   */
  private async resolveMembership(
    identity: SpaceIdentity,
    linkSecret?: string,
  ): Promise<{ role: Role; member?: MemberRow } | null> {
    const ownerSub = this.getOwnerSub();
    if (ownerSub !== null && identity.sub === ownerSub) return { role: "owner" };

    let member = this.getMember(identity.sub);
    member = await this.applyPendingInvites(identity, member);
    if (member) {
      member = await this.refreshMemberProfile(identity, member);
      return { role: this.memberRole(member), member };
    }

    if (linkSecret && (await this.linkSecretIsValid(linkSecret))) {
      if (this.collaboratorCount() >= MAX_COLLABORATORS_PER_ROOM) return null;
      const emails = await verifiedEmailsFor(identity, this.env);
      const joined = this.insertMember(identity, "viewer", "link", emails);
      return { role: "viewer", member: joined };
    }
    return null;
  }

  /** Who is calling an HTTP route: the owner token, a member's account token, or a bare link (reader). */
  private async resolvePrincipal(request: Request): Promise<Principal | null> {
    if (await this.verifyOwnerHeader(request)) {
      return { role: "owner", name: this.getMetaValue("ownerName") ?? undefined };
    }

    const auth = request.headers.get("Authorization") ?? "";
    const bearerMatch = /^Bearer (.+)$/.exec(auth);
    if (bearerMatch) {
      const identity = await this.verifyIdentity(bearerMatch[1] as string);
      // A bearer token alone never registers anyone; joining happens on the socket (with the link)
      // or by claiming an invitation, both of which end up in `resolveMembership`.
      const membership = identity ? await this.resolveMembership(identity) : null;
      if (identity && membership) {
        return {
          role: membership.role,
          sub: identity.sub,
          name: identity.name ?? membership.member?.name ?? undefined,
        };
      }
      // otherwise fall through to other credentials
    }

    const linkSecret = request.headers.get("X-Link-Secret");
    if (linkSecret && (await this.linkSecretIsValid(linkSecret))) return { role: "viewer" };

    return null;
  }

  private async resolveHttpRole(request: Request): Promise<Role | null> {
    return (await this.resolvePrincipal(request))?.role ?? null;
  }

  /** Principal of a route reserved for the owner and admins; otherwise the refusal to return. */
  private async requireManager(request: Request): Promise<Principal | Response> {
    const refusal = this.refuseIfPersonal();
    if (refusal) return refusal;
    // A room that does not exist answers like a refused credential: nothing tells the caller it was ever there.
    if (!this.roomExists()) return Response.json({ error: "unauthorized" }, { status: 401 });
    const principal = await this.resolvePrincipal(request);
    if (!principal) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (!roleCanManage(principal.role)) return Response.json({ error: "forbidden" }, { status: 403 });
    return principal;
  }

  /** Closes the live sockets `shouldClose` selects: access was withdrawn (code 4401, never retried by the client). */
  private closeSockets(shouldClose: (attachment: SocketAttachment) => boolean): void {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = this.getAttachment(socket);
      if (!attachment || !shouldClose(attachment)) continue;
      this.announcePresenceLeave(socket);
      try {
        this.sendError(socket, "unauthorized", "room access was revoked");
        socket.close(4401, "unauthorized");
      } catch {
        // best-effort: the socket may already be closing
      }
    }
  }

  /** A socket from the link alone (no account): the owner token and every account have a `sub` or the owner role. */
  private isAnonymousLinkSocket(attachment: SocketAttachment): boolean {
    return attachment.sub === undefined && attachment.role === "viewer";
  }

  /** Pushes a changed role to every open socket of the account, so a demotion takes effect at once. */
  private pushRole(sub: string, role: Role): void {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = this.getAttachment(socket);
      if (!attachment || attachment.sub !== sub) continue;
      try {
        socket.serializeAttachment({ ...attachment, role });
        socket.send(JSON.stringify({ t: "role", role }));
      } catch {
        // best-effort: the socket may already be closing
      }
    }
  }

  private memberView(row: MemberRow) {
    return {
      sub: row.sub,
      role: this.memberRole(row),
      via: row.via ?? "invite",
      addedAt: row.addedAt,
      ...(row.name ? { name: row.name } : {}),
      ...(row.email ? { email: row.email } : {}),
      ...(row.picture ? { picture: row.picture } : {}),
    };
  }

  private linkView(): { enabled: boolean; linkSecret: string | null } {
    return { enabled: this.linkEnabled(), linkSecret: this.getMetaValue("linkSecret") };
  }

  /** Mints a link secret and makes it the one shown to admins. Older secrets stay valid until revoked. */
  private async mintLinkSecret(): Promise<string> {
    const linkSecret = generateLinkSecret();
    this.sql.exec(
      "INSERT INTO links (secretHash, createdAt) VALUES (?, ?)",
      await sha256Hex(linkSecret),
      new Date().toISOString(),
    );
    this.setMetaValue("linkSecret", linkSecret);
    return linkSecret;
  }

  /** Everybody who got in through the link only; named members keep their access. */
  private revokeLinkReaders(): void {
    const readers = this.sql
      .exec<{ sub: string }>("SELECT sub FROM collaborators WHERE via = 'link'")
      .toArray()
      .map((row) => row.sub);
    this.sql.exec("DELETE FROM collaborators WHERE via = 'link'");
    const gone = new Set(readers);
    this.closeSockets((attachment) =>
      this.isAnonymousLinkSocket(attachment) || (attachment.sub !== undefined && gone.has(attachment.sub)));
  }

  private async handleCreateLink(request: Request): Promise<Response> {
    const principal = await this.requireManager(request);
    if (principal instanceof Response) return principal;
    if (this.linkCount() >= MAX_LINKS_PER_ROOM) {
      return Response.json({ error: "too-many-links" }, { status: 400 });
    }
    const linkSecret = await this.mintLinkSecret();
    this.setMetaValue("linkEnabled", "1");
    return Response.json({ linkSecret }, { status: 201 });
  }

  private async handleRevokeLinks(request: Request): Promise<Response> {
    const principal = await this.requireManager(request);
    if (principal instanceof Response) return principal;
    this.sql.exec("DELETE FROM links");
    this.setMetaValue("linkEnabled", "0");
    this.revokeLinkReaders();
    return new Response(null, { status: 204 });
  }

  /** `GET /link`: whether the link is on, and the secret to copy. */
  private async handleGetLink(request: Request): Promise<Response> {
    const principal = await this.requireManager(request);
    if (principal instanceof Response) return principal;
    return Response.json(this.linkView(), { headers: { "Cache-Control": "no-store" } });
  }

  /**
   * `PUT /link {enabled}`: turns link access on or off. Off ends the access of everybody who came
   * in through the link, never of people invited by name. On again reuses the secret already
   * shown; a room from before the switch (hashes only) gets a fresh one.
   */
  private async handleSetLink(request: Request): Promise<Response> {
    const principal = await this.requireManager(request);
    if (principal instanceof Response) return principal;
    const body = await request.json().catch(() => null);
    if (!isRecord(body) || typeof body.enabled !== "boolean") {
      return Response.json({ error: "invalid-body" }, { status: 400 });
    }
    if (body.enabled) {
      if (this.getMetaValue("linkSecret") === null) {
        if (this.linkCount() >= MAX_LINKS_PER_ROOM) return Response.json({ error: "too-many-links" }, { status: 400 });
        await this.mintLinkSecret();
      }
      this.setMetaValue("linkEnabled", "1");
    } else {
      this.setMetaValue("linkEnabled", "0");
      this.revokeLinkReaders();
    }
    return Response.json(this.linkView());
  }

  /** `POST /link/regenerate`: a new secret; the old link stops working and so does the access of its readers. */
  private async handleRegenerateLink(request: Request): Promise<Response> {
    const principal = await this.requireManager(request);
    if (principal instanceof Response) return principal;
    this.sql.exec("DELETE FROM links");
    await this.mintLinkSecret();
    this.setMetaValue("linkEnabled", "1");
    this.revokeLinkReaders();
    return Response.json(this.linkView(), { status: 201 });
  }

  /**
   * Removes every member and invitation (owner only); live sockets of members are closed. Kept for
   * clients from before per-person sharing; the share dialog removes people one by one.
   */
  private async handleClearCollaborators(request: Request): Promise<Response> {
    const refusal = this.refuseIfPersonal();
    if (refusal) return refusal;
    if (!(await this.verifyOwnerHeader(request))) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    await this.dropAllInvites();
    this.sql.exec("DELETE FROM collaborators");
    this.closeSockets((attachment) => attachment.sub !== undefined);
    return new Response(null, { status: 204 });
  }

  /** `GET /members`: everything the share dialog shows. */
  private async handleListMembers(request: Request): Promise<Response> {
    const principal = await this.requireManager(request);
    if (principal instanceof Response) return principal;
    const members = this.sql
      .exec<MemberRow & Record<string, SqlStorageValue>>(
        "SELECT sub, role, via, addedAt, name, email, emails, picture FROM collaborators ORDER BY addedAt, sub",
      )
      .toArray()
      .map((row) => this.memberView(row));
    const invites = this.sql
      .exec<{ email: string; role: string; invitedByName: string | null; createdAt: string }>(
        "SELECT email, role, invitedByName, createdAt FROM invites ORDER BY createdAt, email",
      )
      .toArray()
      .map((row) => ({
        email: row.email,
        role: isMemberRole(row.role) ? row.role : "viewer",
        createdAt: row.createdAt,
        ...(row.invitedByName ? { invitedByName: row.invitedByName } : {}),
      }));
    const ownerName = this.getMetaValue("ownerName");
    const ownerEmail = this.getMetaValue("ownerEmail");
    const ownerPicture = this.getMetaValue("ownerPicture");
    return Response.json(
      {
        notebookTitle: this.getMetaValue("notebookTitle"),
        you: { role: principal.role, ...(principal.sub ? { sub: principal.sub } : {}) },
        owner: {
          ...(ownerName ? { name: ownerName } : {}),
          ...(ownerEmail ? { email: ownerEmail } : {}),
          ...(ownerPicture ? { picture: ownerPicture } : {}),
        },
        members,
        invites,
        link: this.linkView(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  /** `PATCH /members/:sub {role}`: changes a person's role; open sessions follow at once. */
  private async handleChangeMemberRole(request: Request, sub: string): Promise<Response> {
    const principal = await this.requireManager(request);
    if (principal instanceof Response) return principal;
    const body = await request.json().catch(() => null);
    if (!isRecord(body) || !isMemberRole(body.role)) {
      return Response.json({ error: "invalid-role" }, { status: 400 });
    }
    if (sub === this.getOwnerSub()) return Response.json({ error: "owner-protected" }, { status: 403 });
    const member = this.getMember(sub);
    if (!member) return Response.json({ error: "not-a-member" }, { status: 404 });
    // A person promoted or demoted by name is a named member from then on: the link no longer governs them.
    this.sql.exec("UPDATE collaborators SET role = ?, via = 'invite' WHERE sub = ?", body.role, sub);
    this.pushRole(sub, body.role);
    return Response.json(this.memberView({ ...member, role: body.role, via: "invite" }));
  }

  /** `DELETE /members/:sub`: removes a person; their open sockets close. */
  private async handleRemoveMember(request: Request, sub: string): Promise<Response> {
    const principal = await this.requireManager(request);
    if (principal instanceof Response) return principal;
    if (sub === this.getOwnerSub()) return Response.json({ error: "owner-protected" }, { status: 403 });
    if (!this.getMember(sub)) return new Response(null, { status: 204 });
    this.sql.exec("DELETE FROM collaborators WHERE sub = ?", sub);
    this.closeSockets((attachment) => attachment.sub === sub);
    return new Response(null, { status: 204 });
  }

  /** `POST /leave`: a member leaves on their own. The owner cannot leave. */
  private async handleLeave(request: Request): Promise<Response> {
    const refusal = this.refuseIfPersonal();
    if (refusal) return refusal;
    if (!this.roomExists()) return Response.json({ error: "not-found" }, { status: 404 });
    const auth = request.headers.get("Authorization") ?? "";
    const bearerMatch = /^Bearer (.+)$/.exec(auth);
    const identity = bearerMatch ? await this.verifyIdentity(bearerMatch[1] as string) : null;
    if (!identity) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (identity.sub === this.getOwnerSub()) return Response.json({ error: "owner-protected" }, { status: 403 });
    this.sql.exec("DELETE FROM collaborators WHERE sub = ?", identity.sub);
    this.closeSockets((attachment) => attachment.sub === identity.sub);
    return new Response(null, { status: 204 });
  }

  /**
   * `PUT /owner-profile {jwt}` (owner token): the signed-in owner's name, address and picture, shown
   * in the member list. The account also counts as the owner from then on, so the owner can open the
   * notebook from another signed-in device. Only the holder of the owner token can set it.
   */
  private async handleOwnerProfile(request: Request): Promise<Response> {
    const refusal = this.refuseIfPersonal();
    if (refusal) return refusal;
    if (!(await this.verifyOwnerHeader(request))) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    const body = await request.json().catch(() => null);
    if (!isRecord(body) || typeof body.jwt !== "string") {
      return Response.json({ error: "invalid-body" }, { status: 400 });
    }
    const identity = await this.verifyIdentity(body.jwt);
    if (!identity) return Response.json({ error: "invalid-token" }, { status: 400 });
    const emails = await verifiedEmailsFor(identity, this.env);
    this.setMetaValue("ownerSub", identity.sub);
    this.setMetaValue("ownerEmails", JSON.stringify(emails));
    this.setMetaValue("ownerEmail", emails[0] ?? "");
    this.setMetaValue("ownerName", identity.name ?? "");
    this.setMetaValue("ownerPicture", identity.picture ?? "");
    // The owner is never a member as well.
    this.sql.exec("DELETE FROM collaborators WHERE sub = ?", identity.sub);
    return new Response(null, { status: 204 });
  }

  // ---- Invitations by e-mail ---------------------------------------------

  private roomIdForInbox(): string | null {
    return this.getMetaValue("roomId");
  }

  private async inboxRemove(email: string): Promise<void> {
    const roomId = this.roomIdForInbox();
    if (!roomId) return;
    try {
      await inboxDelete(this.env, email, roomId);
    } catch {
      // The inbox is an index: a stale entry only shows an invitation that no longer opens.
    }
  }

  private async dropAllInvites(): Promise<void> {
    const rows = this.sql.exec<{ email: string }>("SELECT email FROM invites").toArray();
    this.sql.exec("DELETE FROM invites");
    for (const { email } of rows) await this.inboxRemove(email);
  }

  private ownerOwnsEmail(email: string): boolean {
    const raw = this.getMetaValue("ownerEmails");
    if (!raw) return false;
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) && parsed.includes(email);
    } catch {
      return false;
    }
  }

  private memberOwnsEmail(email: string): boolean {
    const rows = this.sql
      .exec<{ email: string | null; emails: string | null }>("SELECT email, emails FROM collaborators")
      .toArray();
    return rows.some((row) => {
      if (row.email === email) return true;
      if (!row.emails) return false;
      try {
        const parsed: unknown = JSON.parse(row.emails);
        return Array.isArray(parsed) && parsed.includes(email);
      } catch {
        return false;
      }
    });
  }

  /** `POST /invites {email, role}`: invites a person by address. Nothing is sent; they see it once they sign in. */
  private async handleCreateInvite(request: Request): Promise<Response> {
    const principal = await this.requireManager(request);
    if (principal instanceof Response) return principal;
    const body = await request.json().catch(() => null);
    if (!isRecord(body)) return Response.json({ error: "invalid-body" }, { status: 400 });
    const email = normalizeEmail(body.email);
    if (!email || email.length > MAX_EMAIL_LENGTH) return Response.json({ error: "invalid-email" }, { status: 400 });
    if (!isMemberRole(body.role)) return Response.json({ error: "invalid-role" }, { status: 400 });
    if (this.ownerOwnsEmail(email)) return Response.json({ error: "is-owner" }, { status: 409 });
    if (this.memberOwnsEmail(email)) return Response.json({ error: "already-member" }, { status: 409 });
    const existing = this.maybeOne(
      this.sql.exec<{ found: number }>("SELECT 1 AS found FROM invites WHERE email = ?", email),
    );
    if (!existing && this.inviteCount() >= MAX_INVITES_PER_ROOM) {
      return Response.json({ error: "too-many-invites" }, { status: 400 });
    }
    const createdAt = new Date().toISOString();
    this.sql.exec(
      `INSERT INTO invites (email, role, invitedBySub, invitedByName, createdAt) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET role = excluded.role, invitedBySub = excluded.invitedBySub, invitedByName = excluded.invitedByName`,
      email,
      body.role,
      principal.sub ?? null,
      principal.name ?? null,
      createdAt,
    );
    const roomId = this.roomIdForInbox();
    if (roomId) {
      const entry: InboxEntry = {
        roomId,
        notebookTitle: this.getMetaValue("notebookTitle") ?? "",
        role: body.role,
        ...(principal.name ? { invitedBy: principal.name } : {}),
        createdAt,
      };
      try {
        await inboxPut(this.env, email, entry);
      } catch {
        // The invitation stands; it is claimed when the person opens the notebook with their account.
      }
    }
    return Response.json({ email, role: body.role, createdAt }, { status: 201 });
  }

  /** `DELETE /invites/:email`: withdraws an invitation that was not claimed yet. */
  private async handleRevokeInvite(request: Request, rawEmail: string): Promise<Response> {
    const principal = await this.requireManager(request);
    if (principal instanceof Response) return principal;
    const email = normalizeEmail(rawEmail);
    if (!email) return Response.json({ error: "invalid-email" }, { status: 400 });
    this.sql.exec("DELETE FROM invites WHERE email = ?", email);
    await this.inboxRemove(email);
    return new Response(null, { status: 204 });
  }

  /** `POST /invites/decline {emails}`: from the Worker, for an account that declined; the addresses are already verified. */
  private async handleDeclineInvites(request: Request): Promise<Response> {
    const body = await request.json().catch(() => null);
    if (!isRecord(body) || !Array.isArray(body.emails)) {
      return Response.json({ error: "invalid-body" }, { status: 400 });
    }
    for (const raw of body.emails) {
      const email = normalizeEmail(raw);
      if (!email) continue;
      this.sql.exec("DELETE FROM invites WHERE email = ?", email);
      await this.inboxRemove(email);
    }
    return new Response(null, { status: 204 });
  }

  // ---- The inbox Durable Object (see inbox.ts) ---------------------------

  private inboxAllowed(): boolean {
    return !this.roomExists() && this.getMetaValue("kind") !== "personal";
  }

  private async handleInboxPut(request: Request): Promise<Response> {
    const body = await request.json().catch(() => null);
    if (
      !this.inboxAllowed()
      || !isRecord(body)
      || typeof body.roomId !== "string"
      || !/^[A-Za-z0-9_-]{1,64}$/.test(body.roomId)
      || typeof body.notebookTitle !== "string"
      || !isMemberRole(body.role)
      || typeof body.createdAt !== "string"
    ) {
      return Response.json({ error: "invalid-body" }, { status: 400 });
    }
    if (this.getMetaValue("kind") === null) this.setMetaValue("kind", "inbox");
    this.sql.exec(
      "INSERT OR REPLACE INTO inbox (roomId, notebookTitle, role, invitedBy, createdAt) VALUES (?, ?, ?, ?, ?)",
      body.roomId,
      body.notebookTitle.slice(0, MAX_NOTEBOOK_TITLE_LENGTH),
      body.role,
      typeof body.invitedBy === "string" ? body.invitedBy.slice(0, 80) : null,
      body.createdAt,
    );
    return new Response(null, { status: 204 });
  }

  private async handleInboxDelete(request: Request): Promise<Response> {
    const body = await request.json().catch(() => null);
    if (!this.inboxAllowed() || !isRecord(body) || typeof body.roomId !== "string") {
      return Response.json({ error: "invalid-body" }, { status: 400 });
    }
    this.sql.exec("DELETE FROM inbox WHERE roomId = ?", body.roomId);
    return new Response(null, { status: 204 });
  }

  private handleInboxList(): Response {
    if (!this.inboxAllowed()) return Response.json({ invitations: [] });
    const invitations = this.sql
      .exec<{ roomId: string; notebookTitle: string; role: string; invitedBy: string | null; createdAt: string }>(
        "SELECT roomId, notebookTitle, role, invitedBy, createdAt FROM inbox ORDER BY createdAt DESC",
      )
      .toArray()
      .map((row) => ({
        roomId: row.roomId,
        notebookTitle: row.notebookTitle,
        role: isMemberRole(row.role) ? row.role : "viewer",
        createdAt: row.createdAt,
        ...(row.invitedBy ? { invitedBy: row.invitedBy } : {}),
      }));
    return Response.json({ invitations }, { headers: { "Cache-Control": "no-store" } });
  }

  /** Removes the ink segments a shared room stored in R2 (all of them, page by page of the listing). */
  private async deleteRoomAssets(): Promise<void> {
    const roomId = this.getMetaValue("assetRoomId");
    const assets = this.env.ASSETS;
    if (!roomId || !assets) return;
    let cursor: string | undefined;
    do {
      const listing = await assets.list({ prefix: `rooms/${roomId}/`, ...(cursor ? { cursor } : {}) });
      if (listing.objects.length > 0) await assets.delete(listing.objects.map((object) => object.key));
      cursor = listing.truncated ? listing.cursor : undefined;
    } while (cursor);
  }

  /** B2: full unshare — wipes every table and evicts every live socket. */
  private async handleDeleteRoom(request: Request): Promise<Response> {
    const refusal = this.refuseIfPersonal();
    if (refusal) return refusal;
    if (!(await this.verifyOwnerHeader(request))) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    this.closeSockets(() => true);
    await this.dropAllInvites();
    await this.deleteRoomAssets();
    await this.ctx.storage.deleteAll();
    // Recreate the (now-empty) schema so subsequent reads on this evicted-but
    // -not-yet-destroyed DO instance don't fail with "no such table"; the
    // room reads back as not-found because `ownerTokenHash` is gone.
    this.ensureSchema();
    return new Response(null, { status: 204 });
  }

  private async handleMeta(request: Request): Promise<Response> {
    if (!this.roomExists()) return Response.json({ error: "not-found" }, { status: 404 });
    const role = await this.resolveHttpRole(request);
    if (!role) return Response.json({ error: "unauthorized" }, { status: 401 });

    const notebookTitle = this.getMetaValue("notebookTitle");
    const docCountRow = this.sql.exec("SELECT COUNT(*) AS n FROM docs").one() as { n: number };

    return Response.json({
      notebookTitle,
      role,
      docCount: docCountRow.n,
    });
  }

  // ---- Personal space (PERSONAL-SYNC.md §3.5, §3.6, §4.2) --------------

  private spaceStats(): {
    kind: "personal";
    docCount: number;
    logBytes: number;
    assetCount: number;
    assetBytes: number;
    createdAt: string;
  } {
    return {
      kind: "personal",
      docCount: this.docCount(),
      logBytes: this.getLogBytes(),
      assetCount: Number(this.getMetaValue("assetCount") ?? "0"),
      assetBytes: Number(this.getMetaValue("assetBytes") ?? "0"),
      createdAt: this.getMetaValue("createdAt") ?? new Date().toISOString(),
    };
  }

  /** `POST /space/init`: idempotent creation of this personal room, called by
   * the Worker with the caller's verified `sub` (PERSONAL-SYNC.md §3.5). */
  private async handleSpaceInit(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "invalid-body" }, { status: 400 });
    }
    if (!isRecord(body) || typeof body.sub !== "string") {
      return Response.json({ error: "invalid-body" }, { status: 400 });
    }
    const sub = body.sub;

    if (!this.roomExists()) {
      const createdAt = new Date().toISOString();
      this.sql.exec(
        "INSERT INTO meta (key, value) VALUES (?, ?), (?, ?), (?, ?)",
        "kind",
        "personal",
        "personalSub",
        sub,
        "createdAt",
        createdAt,
      );
      return Response.json(this.spaceStats(), { status: 201 });
    }

    // Impossible given the deterministic `idFromName(spaceId)` derivation
    // (two different subs never hash to the same spaceId), but the DO fails
    // closed rather than silently reusing another subject's space.
    const existingSub = this.getMetaValue("personalSub");
    if (existingSub === null || existingSub !== sub) {
      return Response.json({ error: "space-owned-by-another-subject" }, { status: 409 });
    }
    return Response.json(this.spaceStats(), { status: 200 });
  }

  /** `GET /space`: read-only descriptor, no side effects. */
  private handleSpaceGet(): Response {
    if (!this.roomExists() || this.getRoomKind() !== "personal") {
      return Response.json({ error: "not-found" }, { status: 404 });
    }
    return Response.json(this.spaceStats(), { status: 200 });
  }

  // ---- Desktop devices (PERSONAL-SYNC.md §3.7) --------------------------

  /** Creates this personal room for `sub` if it does not exist yet; false when
   * the room belongs to someone else or is a shared room. */
  private ensurePersonalRoomFor(sub: string): boolean {
    if (!this.roomExists()) {
      this.sql.exec(
        "INSERT INTO meta (key, value) VALUES (?, ?), (?, ?), (?, ?)",
        "kind",
        "personal",
        "personalSub",
        sub,
        "createdAt",
        new Date().toISOString(),
      );
      return true;
    }
    return this.getRoomKind() === "personal" && this.getMetaValue("personalSub") === sub;
  }

  private isPersonalRoom(): boolean {
    return this.roomExists() && this.getRoomKind() === "personal";
  }

  private getDevice(deviceId: string): DeviceRow | undefined {
    return this.maybeOne(
      this.sql.exec<DeviceRow & Record<string, SqlStorageValue>>("SELECT * FROM devices WHERE deviceId = ?", deviceId),
    );
  }

  private deviceActive(deviceId: string): boolean {
    const device = this.getDevice(deviceId);
    return device !== undefined && Date.now() - device.lastUsedAt <= DEVICE_IDLE_EXPIRY_MS;
  }

  /**
   * Verifies a Clerk JWT or desktop device token. A device token only counts
   * while its device is signed in; the device list lives in the owner's
   * personal-space DO, so a shared room asks that DO.
   */
  private async verifyIdentity(token: string): Promise<SpaceIdentity | null> {
    let identity: SpaceIdentity;
    try {
      identity = await verifySpaceToken(token, this.env);
    } catch {
      return null;
    }
    if (!identity.deviceId) return identity;
    if (this.isPersonalRoom() && this.getMetaValue("personalSub") === identity.sub) {
      return this.deviceActive(identity.deviceId) ? identity : null;
    }
    if (!this.env.PERSONAL_SPACE_SALT) return null;
    const spaceId = await deriveSpaceId(identity.sub, this.env.PERSONAL_SPACE_SALT);
    const home = this.env.NOTEBOOK_ROOM.get(this.env.NOTEBOOK_ROOM.idFromName(spaceId));
    const response = await home.fetch(`https://room.internal/devices/active/${identity.deviceId}`);
    return response.status === 204 ? identity : null;
  }

  private activeDeviceCount(): number {
    const row = this.sql
      .exec("SELECT COUNT(*) AS n FROM devices WHERE lastUsedAt >= ?", Date.now() - DEVICE_IDLE_EXPIRY_MS)
      .one() as { n: number };
    return row.n;
  }

  /** Deletes the device and closes its live sockets. */
  private revokeDevice(deviceId: string): boolean {
    const existed = this.getDevice(deviceId) !== undefined;
    this.sql.exec("DELETE FROM devices WHERE deviceId = ?", deviceId);
    for (const socket of this.ctx.getWebSockets()) {
      if (this.getAttachment(socket)?.deviceId !== deviceId) continue;
      this.announcePresenceLeave(socket);
      try {
        this.sendError(socket, "unauthorized", "device signed out");
        socket.close(4401, "unauthorized");
      } catch {
        // best-effort: the socket may already be closing
      }
    }
    return existed;
  }

  /** `POST /device/code` from the Worker, with the caller's verified Clerk identity. */
  private async handleDeviceCode(request: Request): Promise<Response> {
    const body = await request.json().catch(() => null);
    if (!isRecord(body) || typeof body.sub !== "string" || typeof body.challenge !== "string") {
      return Response.json({ error: "invalid-body" }, { status: 400 });
    }
    if (!this.ensurePersonalRoomFor(body.sub)) {
      return Response.json({ error: "space-owned-by-another-subject" }, { status: 409 });
    }
    if (this.activeDeviceCount() >= MAX_DEVICES_PER_SPACE) {
      return Response.json({ error: "too-many-devices" }, { status: 409 });
    }
    const now = Date.now();
    // Keep used and expired codes a while so a late status poll and a replay
    // are still recognised, then drop them.
    this.sql.exec("DELETE FROM device_codes WHERE expiresAt < ?", now - 10 * 60_000);
    const secret = randomBase64Url(32);
    this.sql.exec(
      "INSERT INTO device_codes (codeHash, challenge, name, picture, expiresAt) VALUES (?, ?, ?, ?, ?)",
      await sha256Hex(secret),
      body.challenge,
      typeof body.name === "string" ? body.name : null,
      typeof body.picture === "string" ? body.picture : null,
      now + DEVICE_CODE_TTL_SECONDS * 1000,
    );
    return Response.json({ secret }, { status: 201 });
  }

  private getDeviceCode(codeHash: string): DeviceCodeRow | undefined {
    return this.maybeOne(
      this.sql.exec<DeviceCodeRow & Record<string, SqlStorageValue>>(
        "SELECT * FROM device_codes WHERE codeHash = ?",
        codeHash,
      ),
    );
  }

  /** `POST /device/code/status`: lets the browser page confirm that the app
   * picked the code up, or tell the user it expired. */
  private async handleDeviceCodeStatus(request: Request): Promise<Response> {
    const body = await request.json().catch(() => null);
    if (!isRecord(body) || typeof body.sub !== "string" || typeof body.secret !== "string") {
      return Response.json({ error: "invalid-body" }, { status: 400 });
    }
    if (!this.isPersonalRoom() || this.getMetaValue("personalSub") !== body.sub) {
      return Response.json({ status: "unknown" });
    }
    const row = this.getDeviceCode(await sha256Hex(body.secret));
    if (!row) return Response.json({ status: "unknown" });
    if (row.usedAt !== null) return Response.json({ status: row.deviceId ? "used" : "expired" });
    if (row.expiresAt < Date.now()) return Response.json({ status: "expired" });
    return Response.json({ status: "pending" });
  }

  private deviceGrant(device: Pick<DeviceRow, "deviceId" | "name" | "picture">, refreshSecret: string) {
    return {
      sub: this.getMetaValue("personalSub"),
      deviceId: device.deviceId,
      refreshSecret,
      ...(device.name ? { name: device.name } : {}),
      ...(device.picture ? { picture: device.picture } : {}),
    };
  }

  /** `POST /device/token`: code exchange (PKCE S256) or refresh-token rotation. */
  private async handleDeviceToken(request: Request): Promise<Response> {
    const invalid = () => Response.json({ error: "invalid_grant" }, { status: 400 });
    const body = await request.json().catch(() => null);
    if (!isRecord(body) || typeof body.secret !== "string" || !this.isPersonalRoom()) return invalid();
    const now = Date.now();
    const presentedHash = await sha256Hex(body.secret);

    if (body.grant === "code" && typeof body.verifier === "string") {
      const row = this.getDeviceCode(presentedHash);
      if (!row) return invalid();
      if (row.usedAt !== null) {
        // RFC 6749 §4.1.2: a code used twice revokes what it issued.
        if (row.deviceId) this.revokeDevice(row.deviceId);
        return invalid();
      }
      // One attempt per code: expired, wrong verifier or success all burn it.
      this.sql.exec("UPDATE device_codes SET usedAt = ? WHERE codeHash = ?", now, presentedHash);
      if (row.expiresAt < now) return invalid();
      if (!constantTimeEqual(await s256(body.verifier), row.challenge)) return invalid();
      if (this.activeDeviceCount() >= MAX_DEVICES_PER_SPACE) {
        return Response.json({ error: "too-many-devices" }, { status: 409 });
      }
      const client = sanitizeClientInfo(body);
      // One installation is one device: signing in again (after a sign-out
      // that never reached the Worker, or a reset of the app's credential)
      // replaces the old row instead of leaving a second entry.
      if (client.installId) {
        const previous = this.sql
          .exec<{ deviceId: string }>("SELECT deviceId FROM devices WHERE installId = ?", client.installId)
          .toArray();
        for (const old of previous) this.revokeDevice(old.deviceId);
      }
      const deviceId = randomBase64Url(16);
      const refreshSecret = randomBase64Url(32);
      this.sql.exec(
        `INSERT INTO devices (deviceId, label, refreshHash, prevRefreshHash, rotatedAt, name, picture, createdAt, lastUsedAt, installId, platform, appVersion)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
        deviceId,
        sanitizeDeviceLabel(body.label),
        await sha256Hex(refreshSecret),
        now,
        row.name,
        row.picture,
        now,
        now,
        client.installId,
        client.platform,
        client.appVersion,
      );
      this.sql.exec("UPDATE device_codes SET deviceId = ? WHERE codeHash = ?", deviceId, presentedHash);
      return Response.json(this.deviceGrant({ deviceId, name: row.name, picture: row.picture }, refreshSecret));
    }

    if (body.grant === "refresh" && typeof body.deviceId === "string") {
      const device = this.getDevice(body.deviceId);
      if (!device) return invalid();
      if (now - device.lastUsedAt > DEVICE_IDLE_EXPIRY_MS) {
        this.revokeDevice(device.deviceId);
        return invalid();
      }
      const current = constantTimeEqual(presentedHash, device.refreshHash);
      const previous = device.prevRefreshHash !== null && constantTimeEqual(presentedHash, device.prevRefreshHash);
      if (previous && now - device.rotatedAt > REFRESH_REUSE_LEEWAY_MS) {
        // An old refresh token came back: someone else may hold a copy.
        this.revokeDevice(device.deviceId);
        return invalid();
      }
      if (!current && !previous) return invalid();
      const refreshSecret = randomBase64Url(32);
      // Within the leeway a retry with the previous token keeps that token as
      // `prevRefreshHash`, so the retry after a lost response still works once.
      this.sql.exec(
        "UPDATE devices SET refreshHash = ?, prevRefreshHash = ?, rotatedAt = ?, lastUsedAt = ?, appVersion = COALESCE(?, appVersion) WHERE deviceId = ?",
        await sha256Hex(refreshSecret),
        current ? device.refreshHash : device.prevRefreshHash,
        current ? now : device.rotatedAt,
        now,
        // An update of the app shows in the list without a new sign-in.
        sanitizeClientInfo(body).appVersion,
        device.deviceId,
      );
      return Response.json(this.deviceGrant(device, refreshSecret));
    }

    return invalid();
  }

  /** `GET /devices`: signed-in desktop devices, for the web account menu. */
  private handleDeviceList(): Response {
    if (!this.isPersonalRoom()) return Response.json({ devices: [] });
    const rows = this.sql
      .exec<{
        deviceId: string;
        label: string;
        createdAt: number;
        lastUsedAt: number;
        platform: string | null;
        appVersion: string | null;
      }>(
        "SELECT deviceId, label, createdAt, lastUsedAt, platform, appVersion FROM devices WHERE lastUsedAt >= ? ORDER BY createdAt",
        Date.now() - DEVICE_IDLE_EXPIRY_MS,
      )
      .toArray();
    return Response.json(
      {
        devices: rows.map((row) => ({
          id: row.deviceId,
          label: row.label,
          createdAt: new Date(row.createdAt).toISOString(),
          lastUsedAt: new Date(row.lastUsedAt).toISOString(),
          ...(row.platform ? { platform: row.platform } : {}),
          ...(row.appVersion ? { appVersion: row.appVersion } : {}),
        })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  /** `DELETE /devices/:id`: signs the device out and closes its sockets. Idempotent. */
  private handleDeviceRevoke(deviceId: string): Response {
    if (!/^[A-Za-z0-9_-]{22}$/.test(deviceId)) return Response.json({ error: "bad-device-id" }, { status: 400 });
    if (this.isPersonalRoom()) this.revokeDevice(deviceId);
    return new Response(null, { status: 204 });
  }

  /** `PATCH /devices/:id`: renames a device. */
  private async handleDeviceRename(deviceId: string, request: Request): Promise<Response> {
    if (!/^[A-Za-z0-9_-]{22}$/.test(deviceId)) return Response.json({ error: "bad-device-id" }, { status: 400 });
    const body = await request.json().catch(() => null);
    if (!isRecord(body) || typeof body.label !== "string") {
      return Response.json({ error: "invalid-request" }, { status: 400 });
    }
    const label = sanitizeDeviceLabel(body.label);
    const device = this.isPersonalRoom() ? this.getDevice(deviceId) : undefined;
    if (!device) return Response.json({ error: "not-found" }, { status: 404 });
    // Older apps put the platform into the label ("HOST (Windows)"); a new
    // name would lose it, so it moves into its own column first.
    const legacyPlatform = device.platform ? null : /\((windows|macos|linux|android|ios)\)\s*$/i.exec(device.label)?.[1];
    this.sql.exec(
      "UPDATE devices SET label = ?, platform = COALESCE(platform, ?) WHERE deviceId = ?",
      label,
      legacyPlatform ? legacyPlatform.toLowerCase() : null,
      deviceId,
    );
    return Response.json({ id: deviceId, label });
  }

  private parseRangeHeader(rangeHeader: string | null): R2Range | undefined {
    if (!rangeHeader) return undefined;
    const match = /^bytes=(\d+)-(\d+)?$/.exec(rangeHeader);
    if (!match) return undefined;
    const start = Number(match[1]);
    const endStr = match[2];
    if (endStr === undefined) return { offset: start };
    return { offset: start, length: Number(endStr) - start + 1 };
  }

  /** `HEAD|PUT|GET|DELETE /assets/:hex` (PERSONAL-SYNC.md §3.5, §4.2). The
   * Worker has already verified the Clerk JWT and derived `spaceId`; it
   * arrives here via `X-Space-Id`, server-derived only, never client-supplied. */
  private async handleAsset(request: Request, hexPart: string): Promise<Response> {
    if (!/^[0-9a-f]{64}$/.test(hexPart)) {
      return Response.json({ error: "bad-asset-id" }, { status: 400 });
    }
    if (this.getRoomKind() !== "personal") {
      return Response.json({ error: "not-a-personal-space" }, { status: 403 });
    }
    if (!this.env.ASSETS) {
      return Response.json({ error: "assets-not-configured" }, { status: 503 });
    }
    const spaceId = request.headers.get("X-Space-Id");
    if (!spaceId) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    const key = `spaces/${spaceId}/${hexPart}`;
    const assets = this.env.ASSETS;

    if (request.method === "HEAD") {
      const obj = await assets.head(key);
      if (!obj) return new Response(null, { status: 404 });
      const headers = new Headers();
      headers.set("content-length", String(obj.size));
      if (obj.httpMetadata?.contentType) headers.set("content-type", obj.httpMetadata.contentType);
      return new Response(null, { status: 200, headers });
    }

    if (request.method === "GET") {
      const range = this.parseRangeHeader(request.headers.get("Range"));
      const obj = await assets.get(key, range ? { range } : undefined);
      if (!obj) return new Response(null, { status: 404 });
      const headers = new Headers();
      headers.set("content-length", String(obj.size));
      if (obj.httpMetadata?.contentType) headers.set("content-type", obj.httpMetadata.contentType);
      headers.set("cache-control", "private, max-age=31536000, immutable");
      const isPartial = range !== undefined && obj.range !== undefined;
      return new Response(obj.body, { status: isPartial ? 206 : 200, headers });
    }

    if (request.method === "PUT") {
      const contentLengthHeader = request.headers.get("content-length");
      if (!contentLengthHeader) {
        return Response.json({ error: "length-required" }, { status: 411 });
      }
      const size = Number(contentLengthHeader);
      if (!Number.isFinite(size) || size < 0) {
        return Response.json({ error: "length-required" }, { status: 411 });
      }
      if (size > MAX_ASSET_BYTES) {
        return Response.json({ error: "asset-too-large" }, { status: 413 });
      }

      const existing = await assets.head(key);
      if (existing) {
        return Response.json(
          { assetId: `sha256:${hexPart}`, size: existing.size, deduplicated: true },
          { status: 200 },
        );
      }

      const currentAssetBytes = Number(this.getMetaValue("assetBytes") ?? "0");
      if (currentAssetBytes + size > SPACE_ASSET_QUOTA_BYTES) {
        return Response.json({ error: "quota-exceeded" }, { status: 413 });
      }

      const contentType = request.headers.get("content-type") ?? "application/octet-stream";
      try {
        await assets.put(key, request.body, {
          sha256: hexPart,
          httpMetadata: { contentType, cacheControl: "private, max-age=31536000, immutable" },
          customMetadata: { size: String(size) },
        });
      } catch {
        // R2 rejected the claimed checksum; the bytes are not stored.
        return Response.json({ error: "checksum-mismatch" }, { status: 400 });
      }

      this.setMetaValue("assetBytes", String(currentAssetBytes + size));
      this.setMetaValue("assetCount", String(Number(this.getMetaValue("assetCount") ?? "0") + 1));
      return Response.json({ assetId: `sha256:${hexPart}`, size }, { status: 201 });
    }

    // DELETE: idempotent, always 204.
    const existing = await assets.head(key);
    if (existing) {
      await assets.delete(key);
      const nextBytes = Math.max(0, Number(this.getMetaValue("assetBytes") ?? "0") - existing.size);
      const nextCount = Math.max(0, Number(this.getMetaValue("assetCount") ?? "0") - 1);
      this.setMetaValue("assetBytes", String(nextBytes));
      this.setMetaValue("assetCount", String(nextCount));
    }
    return new Response(null, { status: 204 });
  }

  /**
   * `HEAD|GET|PUT /room-assets/:hex`: content-addressed blobs (ink segments) of a
   * shared room; a blob that is not stored answers 204. The Worker derives `X-Room-Id` from the URL. Reading needs any
   * credential the room accepts (owner, link, registered collaborator); writing
   * needs the owner or a collaborator. Objects live under `rooms/<roomId>/` in
   * the same bucket as the personal assets and are removed with the room.
   */
  private async handleRoomAsset(request: Request, hexPart: string): Promise<Response> {
    if (!/^[0-9a-f]{64}$/.test(hexPart)) {
      return Response.json({ error: "bad-asset-id" }, { status: 400 });
    }
    if (!this.roomExists() || this.getRoomKind() !== "shared") {
      return Response.json({ error: "not-found" }, { status: 404 });
    }
    const roomId = request.headers.get("X-Room-Id") ?? "";
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(roomId)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    if (!this.env.ASSETS) {
      return Response.json({ error: "assets-not-configured" }, { status: 503 });
    }
    const role = await this.resolveHttpRole(request);
    if (!role) return Response.json({ error: "unauthorized" }, { status: 401 });
    const key = `rooms/${roomId}/${hexPart}`;
    const assets = this.env.ASSETS;

    if (request.method === "HEAD" || request.method === "GET") {
      const obj = request.method === "HEAD" ? await assets.head(key) : await assets.get(key);
      // "Not stored yet" is an ordinary answer (the owner uploads a moment after the page document
      // arrives), so it is a 204 and not an error status that every browser logs to its console.
      if (!obj) return new Response(null, { status: 204, headers: { "x-canvink-absent": "1" } });
      const headers = new Headers();
      headers.set("content-length", String(obj.size));
      if (obj.httpMetadata?.contentType) headers.set("content-type", obj.httpMetadata.contentType);
      if (request.method === "HEAD") return new Response(null, { status: 200, headers });
      headers.set("cache-control", "private, max-age=31536000, immutable");
      return new Response((obj as R2ObjectBody).body, { status: 200, headers });
    }

    // A refused upload never reads its body; release the stream.
    const refuse = (response: Response): Response => {
      void request.body?.cancel().catch(() => undefined);
      return response;
    };
    // Ink segments are writes like any other: only the owner, admins and editors may store them.
    if (!roleCanWrite(role)) return refuse(Response.json({ error: "read-only" }, { status: 403 }));
    const size = Number(request.headers.get("content-length"));
    if (!request.headers.get("content-length") || !Number.isFinite(size) || size < 0) {
      return refuse(Response.json({ error: "length-required" }, { status: 411 }));
    }
    if (size > MAX_ROOM_ASSET_BYTES) return refuse(Response.json({ error: "asset-too-large" }, { status: 413 }));
    const existing = await assets.head(key);
    if (existing) {
      return refuse(Response.json({ assetId: `sha256:${hexPart}`, size: existing.size, deduplicated: true }, { status: 200 }));
    }
    const used = Number(this.getMetaValue("assetBytes") ?? "0");
    if (used + size > ROOM_ASSET_QUOTA_BYTES) return refuse(Response.json({ error: "quota-exceeded" }, { status: 413 }));
    try {
      await assets.put(key, request.body, {
        sha256: hexPart,
        httpMetadata: {
          contentType: request.headers.get("content-type") ?? "application/octet-stream",
          cacheControl: "private, max-age=31536000, immutable",
        },
      });
    } catch {
      return refuse(Response.json({ error: "checksum-mismatch" }, { status: 400 }));
    }
    this.setMetaValue("assetBytes", String(used + size));
    // Remembered so that deleting the room can remove its objects.
    this.setMetaValue("assetRoomId", roomId);
    return Response.json({ assetId: `sha256:${hexPart}`, size }, { status: 201 });
  }

  // ---- WebSocket ------------------------------------------------------

  private handleWebSocketUpgrade(request: Request): Response {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  private sendError(ws: WebSocket, code: ErrorCode, detail?: string): void {
    ws.send(JSON.stringify({ t: "error", code, detail }));
  }

  private closeUnauthorized(ws: WebSocket, detail: string): void {
    this.sendError(ws, "unauthorized", detail);
    ws.close(4401, "unauthorized");
  }

  private getAttachment(ws: WebSocket): SocketAttachment | null {
    return (ws.deserializeAttachment() as SocketAttachment | null) ?? null;
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    try {
      // Frames are ASCII JSON (base64url payloads), so the UTF-16 length is
      // the byte length; only a string near the limit needs the exact count.
      const byteLength =
        typeof message !== "string"
          ? message.byteLength
          : message.length * 3 <= MAX_FRAME_BYTES
            ? message.length
            : new TextEncoder().encode(message).byteLength;
      if (byteLength > MAX_FRAME_BYTES) {
        this.sendError(ws, "payload-too-large", "frame exceeds max size");
        return;
      }

      let raw: unknown;
      try {
        raw = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
      } catch {
        this.sendError(ws, "bad-frame", "invalid JSON");
        return;
      }

      if (!isRecord(raw) || typeof raw.t !== "string") {
        this.sendError(ws, "bad-frame", "missing frame type");
        if (!this.getAttachment(ws)) ws.close(4400, "bad-frame");
        return;
      }

      const attachment = this.getAttachment(ws);

      if (!attachment) {
        if (raw.t !== "hello") {
          // Protocol requires hello as the first frame; without an
          // established role there's nothing safe to do with any other
          // frame type.
          this.closeUnauthorized(ws, "first frame must be hello");
          return;
        }
        if (!isValidHelloFrame(raw)) {
          this.sendError(ws, "bad-frame", "malformed hello");
          ws.close(4400, "bad-frame");
          return;
        }
        await this.handleHello(ws, raw);
        return;
      }

      // PERSONAL-SYNC.md §2.6, §3.4: on a personal socket (`authExpiresAt`
      // set), a write past its JWT's expiry plus the 120s grace is a fatal
      // unauthorized close — the client must have reauthed by then.
      const isWriteFrame =
        raw.t === "append" || raw.t === "snapshot" || raw.t === "announce" || raw.t === "remove";
      if (isWriteFrame && attachment.authExpiresAt !== undefined) {
        const now = Math.floor(Date.now() / 1000);
        if (now > attachment.authExpiresAt + AUTH_EXPIRY_GRACE_SECONDS) {
          this.closeUnauthorized(ws, "auth expired");
          return;
        }
      }

      // Access is decided by what the room says now, not by what the socket was told at `hello`: a
      // removed person's socket is closed here even if the close push never reached it, and a
      // changed role takes effect on the very next frame.
      const current = raw.t === "ping" ? attachment : this.currentAttachment(ws, attachment);
      if (!current) {
        this.closeUnauthorized(ws, "room access was revoked");
        return;
      }

      switch (raw.t) {
        case "ping":
          ws.send(JSON.stringify({ t: "pong" }));
          return;
        case "presence":
          if (!isValidPresenceFrame(raw)) {
            this.sendError(ws, "bad-frame", "malformed presence");
            return;
          }
          this.handlePresence(ws, current, raw);
          return;
        case "reauth":
          if (!isValidReauthFrame(raw)) {
            this.sendError(ws, "bad-frame", "malformed reauth");
            return;
          }
          await this.handleReauth(ws, current, raw);
          return;
        case "append":
          if (!isValidAppendFrame(raw)) {
            this.sendError(ws, "bad-frame", "malformed append");
            return;
          }
          await this.handleAppend(ws, current, raw);
          return;
        case "snapshot":
          if (!isValidSnapshotFrame(raw)) {
            this.sendError(ws, "bad-frame", "malformed snapshot");
            return;
          }
          await this.handleSnapshot(ws, current, raw);
          return;
        case "announce":
          if (!isValidAnnounceFrame(raw)) {
            this.sendError(ws, "bad-frame", "malformed announce");
            return;
          }
          await this.handleAnnounce(ws, current, raw);
          return;
        case "remove":
          if (!isValidRemoveFrame(raw)) {
            this.sendError(ws, "bad-frame", "malformed remove");
            return;
          }
          await this.handleRemove(ws, current, raw);
          return;
        case "fetch":
          if (!isValidFetchFrame(raw)) {
            this.sendError(ws, "bad-frame", "malformed fetch");
            return;
          }
          this.handleFetch(ws, raw);
          return;
        case "hello":
          this.sendError(ws, "bad-frame", "hello already sent");
          return;
        default:
          this.sendError(ws, "bad-frame", "unknown frame type");
      }
    } catch (err) {
      // D6: an unexpected exception must never wedge the socket silently.
      try {
        this.sendError(ws, "bad-frame", err instanceof Error ? err.message : "internal error");
      } catch {
        // ignore: best-effort notification before the close below
      }
      try {
        ws.close(1011, "internal error");
      } catch {
        // socket may already be closing
      }
    }
  }

  /** The role the room currently grants the socket's account, or `null` once access was withdrawn. */
  private liveRole(attachment: SocketAttachment): Role | null {
    if (attachment.sub !== undefined) {
      if (attachment.sub === this.getOwnerSub()) return "owner";
      const member = this.getMember(attachment.sub);
      return member ? this.memberRole(member) : null;
    }
    // Without an account: the owner token, or the bare link (always a reader).
    return attachment.role === "owner" ? "owner" : "viewer";
  }

  /** The socket's attachment with the live role; a changed role is stored and pushed to the client. */
  private currentAttachment(ws: WebSocket, attachment: SocketAttachment): SocketAttachment | null {
    if (this.getRoomKind() === "personal") return attachment;
    const role = this.liveRole(attachment);
    if (role === null) return null;
    if (role === attachment.role) return attachment;
    const updated: SocketAttachment = { ...attachment, role };
    ws.serializeAttachment(updated);
    try {
      ws.send(JSON.stringify({ t: "role", role }));
    } catch {
      // best-effort: the socket may already be closing
    }
    return updated;
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    // All durable state lives in SQLite; the only per-socket cleanup is
    // telling the others that this socket's presence is gone.
    this.announcePresenceLeave(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    // Errors surface to the client via connection close; nothing to persist.
    this.announcePresenceLeave(ws);
  }

  /**
   * Relays an ephemeral presence state to every other authenticated socket.
   * Never stored in SQLite and never acknowledged. Viewers may send presence
   * too (their cursor is useful to the others); the server stamps `role` so a
   * client can ignore live ink from a read-only socket.
   */
  private handlePresence(ws: WebSocket, attachment: SocketAttachment, frame: ClientFramePresence): void {
    const stamped = stampVerifiedProfile(frame.state, attachment);
    // Live ink is drawing, and a reader does not draw: the pointer and page of a reader are relayed,
    // their strokes are not.
    const state = !roleCanWrite(attachment.role) && stamped.ink != null ? { ...stamped, ink: null } : stamped;
    const stateText = JSON.stringify(state);
    if (new TextEncoder().encode(stateText).byteLength > MAX_PRESENCE_STATE_BYTES) {
      this.sendError(ws, "payload-too-large", "presence state exceeds max size");
      return;
    }
    if (!this.takePresenceToken(ws)) return; // over budget: drop silently
    const connId = attachment.connId ?? this.assignConnId(ws, attachment);
    const message = `{"t":"presence","from":${JSON.stringify(connId)},"role":${JSON.stringify(attachment.role)},"state":${stateText}}`;
    this.lastPresence.set(connId, message);
    this.broadcastRaw(ws, message);
  }

  private takePresenceToken(ws: WebSocket): boolean {
    const now = Date.now();
    const budget = this.presenceBudget.get(ws) ?? { tokens: PRESENCE_BURST, at: now };
    const refilled = Math.min(
      PRESENCE_BURST,
      budget.tokens + ((now - budget.at) / 1000) * PRESENCE_REFILL_PER_SECOND,
    );
    if (refilled < 1) {
      this.presenceBudget.set(ws, { tokens: refilled, at: now });
      return false;
    }
    this.presenceBudget.set(ws, { tokens: refilled - 1, at: now });
    return true;
  }

  private assignConnId(ws: WebSocket, attachment: SocketAttachment): string {
    const connId = randomBase64Url(9);
    ws.serializeAttachment({ ...attachment, connId });
    return connId;
  }

  private announcePresenceLeave(ws: WebSocket): void {
    const connId = this.getAttachment(ws)?.connId;
    if (!connId) return;
    const hadPresence = this.lastPresence.delete(connId);
    if (!hadPresence) return;
    this.broadcastRaw(ws, JSON.stringify({ t: "presence-leave", from: connId }));
  }

  /** Sends the latest presence of every other live socket to a socket that just synced. */
  private replayPresence(ws: WebSocket): void {
    if (this.lastPresence.size === 0) return;
    const live = new Set<string>();
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === ws) continue;
      const connId = this.getAttachment(socket)?.connId;
      if (connId) live.add(connId);
    }
    for (const [connId, message] of this.lastPresence) {
      if (!live.has(connId)) {
        this.lastPresence.delete(connId);
        continue;
      }
      ws.send(message);
    }
  }

  private async resolveWsRole(
    auth: HelloAuth,
  ): Promise<
    { role: Role; sub?: string; authExpiresAt?: number; name?: string; picture?: string; deviceId?: string } | null
  > {
    const roomKind = this.getRoomKind();

    if (auth.kind === "personal") {
      // PERSONAL-SYNC.md §3.2: `resolveWsRole` extension; §3.7: a desktop
      // device token counts as its `sub` while the device is signed in.
      if (roomKind !== "personal") return null;
      const identity = await this.verifyIdentity(auth.jwt);
      if (!identity) return null;
      const personalSub = this.getMetaValue("personalSub");
      if (identity.sub !== personalSub) return null;
      return {
        role: "owner",
        sub: identity.sub,
        authExpiresAt: identity.exp,
        ...verifiedProfile(identity),
        ...(identity.deviceId ? { deviceId: identity.deviceId } : {}),
      };
    }

    // PERSONAL-SYNC.md §3.1: cross-kind refusal — a personal room never
    // accepts an "owner" / "link" / "user" hello.
    if (roomKind === "personal") return null;

    if (auth.kind === "owner") {
      const ownerTokenHash = this.getMetaValue("ownerTokenHash");
      if (!ownerTokenHash) return null;
      const providedHash = await sha256Hex(auth.ownerToken);
      return constantTimeEqual(providedHash, ownerTokenHash) ? { role: "owner" } : null;
    }

    if (auth.kind === "link") {
      return (await this.linkSecretIsValid(auth.linkSecret)) ? { role: "viewer" } : null;
    }

    // auth.kind === "user". A desktop device token works here too (§3.7).
    const identity = await this.verifyIdentity(auth.jwt);
    if (!identity) return null;

    // The role comes from the room alone (`resolveMembership`): a link only ever makes a reader, and
    // a person already invited by name keeps the role they were given.
    const membership = await this.resolveMembership(identity, auth.linkSecret);
    if (!membership) return null;
    return { role: membership.role, sub: identity.sub, ...verifiedProfile(identity) };
  }

  private async handleHello(
    ws: WebSocket,
    frame: ClientFrameHello,
  ): Promise<void> {
    if (!this.roomExists()) {
      this.closeUnauthorized(ws, "room not found");
      return;
    }

    const resolved = await this.resolveWsRole(frame.auth);
    if (!resolved) {
      this.closeUnauthorized(ws, "invalid credentials");
      return;
    }

    const attachment: SocketAttachment = {
      role: resolved.role,
      sub: resolved.sub,
      authExpiresAt: resolved.authExpiresAt,
      connId: randomBase64Url(9),
      ...verifiedProfile(resolved),
      ...(resolved.deviceId ? { deviceId: resolved.deviceId } : {}),
    };
    ws.serializeAttachment(attachment);

    // A lazy personal client asks for page documents itself (`fetch`); replaying the whole
    // account up front is what made a fresh device wait for every page before it showed any.
    // The welcome says the room honours the flag, so a client never mistakes an older Worker's
    // full replay for documents it did not ask for.
    const lazy = frame.lazy === true && this.getRoomKind() === "personal";

    // A personal room never sets `notebookTitle`; `welcome.notebookTitle` is
    // `""` there (PERSONAL-SYNC.md §4.1) and needs no client parser change.
    const notebookTitle = this.getMetaValue("notebookTitle") ?? "";
    const docs = this.sql
      .exec("SELECT docId, kind FROM docs")
      .toArray() as { docId: string; kind: string }[];

    ws.send(
      JSON.stringify({
        t: "welcome",
        role: resolved.role,
        docs: docs.map((d) => ({ docId: d.docId, kind: d.kind })),
        notebookTitle,
        ...(lazy ? { lazy: true } : {}),
      }),
    );

    const since = frame.since ?? {};
    for (const doc of docs) {
      const hasClientSince = Object.prototype.hasOwnProperty.call(since, doc.docId);
      if (lazy && doc.kind === "page" && !hasClientSince) continue;
      this.replayDoc(ws, doc.docId, hasClientSince, since[doc.docId] ?? 0);
    }

    ws.send(JSON.stringify({ t: "synced" }));
    this.replayPresence(ws);
  }

  /**
   * Sends one document's state to a socket: its snapshot unless the client already holds state at
   * or past `covers`, then every change after the newer of `covers` and what the client holds.
   */
  private replayDoc(ws: WebSocket, docId: string, hasClientSince: boolean, clientSince: number): void {
    const docRow = this.maybeOne(
      this.sql.exec("SELECT docId, kind, snapshot, covers FROM docs WHERE docId = ?", docId),
    ) as DocRow | undefined;
    if (!docRow) return;

    // A client that never reported a `since` entry for this doc has never
    // seen it at all (a brand-new join, not a resume) and must always get
    // the snapshot regardless of `covers` — `covers` is 0 by default for a
    // doc that has never been compacted, which would otherwise be
    // indistinguishable from "the client already holds covers=0 worth of
    // state". Only an *explicit* `since` entry means "I already have up to
    // this seq".
    //
    // B1a: skip the snapshot entirely when the client already has state at
    // or past `covers` — it already holds everything the snapshot would
    // give it, so resending it (and having the client replace its live doc
    // with a stale-relative-to-local-edits copy) is both wasteful and, on
    // the client, actively destructive without the merge fix in session.ts.
    if (docRow.snapshot !== null && (!hasClientSince || clientSince < docRow.covers)) {
      ws.send(
        JSON.stringify({
          t: "snapshot",
          docId,
          payload: bytesToBase64Url(this.loadPayload(docId, 0, docRow.snapshot)),
          covers: docRow.covers,
        }),
      );
    }

    const baseline = Math.max(docRow.covers, clientSince);
    const rows = this.sql
      .exec("SELECT seq, payload FROM changes WHERE docId = ? AND seq > ? ORDER BY seq ASC", docId, baseline)
      .toArray() as { seq: number; payload: ArrayBuffer }[];
    for (const row of rows) {
      ws.send(
        JSON.stringify({
          t: "append",
          docId,
          payload: bytesToBase64Url(this.loadPayload(docId, row.seq, row.payload)),
          seq: row.seq,
        }),
      );
    }
  }

  /**
   * Answers a `fetch`: the requested documents, replayed like in `hello`, then one `fetched`
   * frame. The Durable Object handles frames one at a time, so what follows the reply is newer
   * than anything in it and the client never misses a change between the two.
   */
  private handleFetch(ws: WebSocket, frame: ClientFrameFetch): void {
    const since = frame.since ?? {};
    const sent: string[] = [];
    for (const docId of new Set(frame.docIds)) {
      const exists = this.maybeOne(
        this.sql.exec<{ found: number }>("SELECT 1 AS found FROM docs WHERE docId = ?", docId),
      );
      if (!exists) continue;
      this.replayDoc(ws, docId, Object.prototype.hasOwnProperty.call(since, docId), since[docId] ?? 0);
      sent.push(docId);
    }
    ws.send(JSON.stringify({ t: "fetched", ...(frame.id === undefined ? {} : { id: frame.id }), docIds: frame.docIds, known: sent }));
  }

  /** In-band JWT refresh for a live personal socket (PERSONAL-SYNC.md §3.4, P6). */
  private async handleReauth(
    ws: WebSocket,
    attachment: SocketAttachment,
    frame: ClientFrameReauth,
  ): Promise<void> {
    if (attachment.role !== "owner" || attachment.authExpiresAt === undefined) {
      // Valid only on a personal socket; non-fatal on a shared socket.
      this.sendError(ws, "bad-frame", "reauth is only valid on a personal-room socket");
      return;
    }

    // §7: at least 5s between accepted reauth frames per socket, best-effort
    // (same per-isolate caveat as the other rate limiters in this repo).
    const now = Date.now();
    const last = this.reauthTimestamps.get(ws);
    if (last !== undefined && now - last < 5000) {
      this.sendError(ws, "bad-frame", "reauth too frequent");
      return;
    }

    const identity = await this.verifyIdentity(frame.jwt);
    if (!identity) {
      this.closeUnauthorized(ws, "invalid reauth token");
      return;
    }

    // A socket never changes identity (same rule that refuses a second hello),
    // and a device socket stays that device's socket.
    if (identity.sub !== attachment.sub || identity.deviceId !== attachment.deviceId) {
      this.closeUnauthorized(ws, "reauth must not change the socket's identity");
      return;
    }

    this.reauthTimestamps.set(ws, now);
    const updated: SocketAttachment = { ...attachment, authExpiresAt: identity.exp, ...verifiedProfile(identity) };
    ws.serializeAttachment(updated);
    ws.send(JSON.stringify({ t: "reauthed", expiresAt: identity.exp }));
  }

  private broadcast(sender: WebSocket, payload: unknown): void {
    this.broadcastRaw(sender, JSON.stringify(payload));
  }

  /**
   * Sends to every other socket that completed `hello`. A socket that is
   * connected but never authenticated (for example someone who kept a roomId
   * after their link was revoked) must not receive live document changes or
   * presence, so sockets without an attachment are skipped.
   */
  private broadcastRaw(sender: WebSocket, message: string): void {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === sender) continue;
      if (!this.getAttachment(socket)) continue;
      try {
        socket.send(message);
      } catch {
        // best-effort broadcast; a dead socket will surface via close/error
      }
    }
  }

  private docLogByteSize(docId: string): number {
    return this.snapshotBytes(docId) + this.changesBytes(docId);
  }

  private docCount(): number {
    const row = this.sql.exec("SELECT COUNT(*) AS n FROM docs").one() as { n: number };
    return row.n;
  }

  /** D1: allow-list role check — only owner/editor may write. Anything else (viewer, or an unrecognized future role) is denied by default. */
  private canWrite(attachment: SocketAttachment): boolean {
    return roleCanWrite(attachment.role);
  }

  private async handleAppend(
    ws: WebSocket,
    attachment: SocketAttachment,
    frame: ClientFrameAppend,
  ): Promise<void> {
    if (!this.canWrite(attachment)) {
      this.sendError(ws, "read-only");
      return;
    }

    const docRow = this.maybeOne(
      this.sql.exec<{ found: number }>("SELECT 1 AS found FROM docs WHERE docId = ?", frame.docId),
    );
    if (!docRow) {
      this.sendError(ws, "unknown-doc", frame.docId);
      return;
    }

    const payloadBytes = base64UrlToBuffer(frame.payload);
    if (this.docLogByteSize(frame.docId) + payloadBytes.byteLength > MAX_DOC_LOG_BYTES) {
      this.sendError(ws, "payload-too-large", frame.docId);
      return;
    }

    const roomKind = this.getRoomKind();
    if (roomKind === "personal" && this.getLogBytes() + this.storedCost(payloadBytes.byteLength) > MAX_SPACE_LOG_BYTES) {
      // §3.6, §7: non-fatal — the socket stays open, the frame is dropped.
      this.sendError(ws, "quota-exceeded", "space log quota exceeded");
      return;
    }

    // `seq` must continue past `covers`, not just past the highest retained
    // change: a prior snapshot may have deleted every change row for this
    // doc, which would otherwise make the next seq restart at 1.
    const maxSeqRow = this.sql
      .exec(
        `SELECT MAX(v) AS maxSeq FROM (
           SELECT COALESCE(MAX(seq), 0) AS v FROM changes WHERE docId = ?
           UNION ALL
           SELECT COALESCE(covers, 0) AS v FROM docs WHERE docId = ?
         )`,
        frame.docId,
        frame.docId,
      )
      .one() as { maxSeq: number };
    const seq = maxSeqRow.maxSeq + 1;

    this.sql.exec(
      "INSERT INTO changes (docId, seq, payload) VALUES (?, ?, ?)",
      frame.docId,
      seq,
      this.storePayload(frame.docId, seq, payloadBytes),
    );

    if (roomKind === "personal") this.adjustLogBytes(this.storedCost(payloadBytes.byteLength));

    this.broadcast(ws, { t: "append", docId: frame.docId, payload: frame.payload, seq });
    // B1c: ack the sender only (never broadcast — other sockets get the
    // regular `append` frame above and drive their own compaction off their
    // own acked appends).
    ws.send(JSON.stringify({ t: "seq", docId: frame.docId, seq }));
  }

  private async handleSnapshot(
    ws: WebSocket,
    attachment: SocketAttachment,
    frame: ClientFrameSnapshot,
  ): Promise<void> {
    if (!this.canWrite(attachment)) {
      this.sendError(ws, "read-only");
      return;
    }

    const roomKind = this.getRoomKind();
    // PERSONAL-SYNC.md §3.3: a buggy or hostile client cannot smuggle a
    // personal-shaped doc into a shared notebook.
    if (frame.docId === WORKSPACE_ROOT_DOC_ID && roomKind !== "personal") {
      this.sendError(ws, "bad-frame", "workspace doc not allowed in a shared room");
      return;
    }

    const payloadBytes = base64UrlToBuffer(frame.payload);
    if (payloadBytes.byteLength > MAX_DOC_LOG_BYTES) {
      this.sendError(ws, "payload-too-large", frame.docId);
      return;
    }

    const isNewDoc = !this.maybeOne(
      this.sql.exec<{ found: number }>("SELECT 1 AS found FROM docs WHERE docId = ?", frame.docId),
    );
    const maxDocs = roomKind === "personal" ? MAX_DOCS_PER_SPACE : MAX_DOCS_PER_ROOM;
    if (isNewDoc && this.docCount() >= maxDocs) {
      this.sendError(ws, "payload-too-large", "too many docs in room");
      return;
    }

    let logByteDelta = this.storedCost(payloadBytes.byteLength);
    if (roomKind === "personal") {
      logByteDelta =
        this.storedCost(payloadBytes.byteLength) -
        this.snapshotBytes(frame.docId) -
        this.changesBytes(frame.docId, frame.covers);

      if (this.getLogBytes() + logByteDelta > MAX_SPACE_LOG_BYTES) {
        this.sendError(ws, "quota-exceeded", "space log quota exceeded");
        return;
      }
    }

    this.sql.exec(
      `INSERT INTO docs (docId, kind, snapshot, covers)
       VALUES (?, COALESCE((SELECT kind FROM docs WHERE docId = ?), 'unknown'), ?, ?)
       ON CONFLICT(docId) DO UPDATE SET snapshot = excluded.snapshot, covers = excluded.covers`,
      frame.docId,
      frame.docId,
      this.storePayload(frame.docId, 0, payloadBytes),
      frame.covers,
    );
    this.deleteChangesThrough(frame.docId, frame.covers);

    if (roomKind === "personal") this.adjustLogBytes(logByteDelta);

    this.broadcast(ws, {
      t: "snapshot",
      docId: frame.docId,
      payload: frame.payload,
      covers: frame.covers,
    });
  }

  private async handleAnnounce(
    ws: WebSocket,
    attachment: SocketAttachment,
    frame: ClientFrameAnnounce,
  ): Promise<void> {
    if (!this.canWrite(attachment)) {
      this.sendError(ws, "read-only");
      return;
    }

    const roomKind = this.getRoomKind();
    // PERSONAL-SYNC.md §3.3: a `workspace` doc is only legal in a personal
    // room, and only under the pinned docId; anything else here is a
    // non-fatal `bad-frame` rather than silent corruption.
    const looksLikeWorkspaceDoc = frame.kind === "workspace" || frame.docId === WORKSPACE_ROOT_DOC_ID;
    if (looksLikeWorkspaceDoc) {
      if (roomKind !== "personal") {
        this.sendError(ws, "bad-frame", "workspace doc not allowed in a shared room");
        return;
      }
      if (frame.kind !== "workspace" || frame.docId !== WORKSPACE_ROOT_DOC_ID) {
        this.sendError(ws, "bad-frame", "workspace doc must use docId 'workspace:root'");
        return;
      }
    }

    const isNewDoc = !this.maybeOne(
      this.sql.exec<{ found: number }>("SELECT 1 AS found FROM docs WHERE docId = ?", frame.docId),
    );
    const maxDocs = roomKind === "personal" ? MAX_DOCS_PER_SPACE : MAX_DOCS_PER_ROOM;
    if (isNewDoc && this.docCount() >= maxDocs) {
      this.sendError(ws, "payload-too-large", "too many docs in room");
      return;
    }

    this.sql.exec(
      `INSERT INTO docs (docId, kind, snapshot, covers) VALUES (?, ?, NULL, 0)
       ON CONFLICT(docId) DO NOTHING`,
      frame.docId,
      frame.kind,
    );

    this.broadcast(ws, { t: "announce", docId: frame.docId, kind: frame.kind });
  }

  private async handleRemove(
    ws: WebSocket,
    attachment: SocketAttachment,
    frame: ClientFrameRemove,
  ): Promise<void> {
    if (!this.canWrite(attachment)) {
      this.sendError(ws, "read-only");
      return;
    }

    const roomKind = this.getRoomKind();
    const removedBytes = roomKind === "personal" ? this.docLogByteSize(frame.docId) : 0;

    this.sql.exec("DELETE FROM docs WHERE docId = ?", frame.docId);
    this.sql.exec("DELETE FROM changes WHERE docId = ?", frame.docId);
    this.sql.exec("DELETE FROM chunks WHERE docId = ?", frame.docId);

    if (roomKind === "personal" && removedBytes > 0) this.adjustLogBytes(-removedBytes);

    this.broadcast(ws, { t: "remove", docId: frame.docId });
  }
}
/** `decodeURIComponent` that answers `null` for a malformed escape instead of throwing. */
function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function base64UrlToBuffer(b64url: string): Uint8Array {
  return base64UrlToBytes(b64url);
}

function verifiedProfile(identity: { name?: string; picture?: string }): { name?: string; picture?: string } {
  return {
    ...(identity.name ? { name: identity.name } : {}),
    ...(identity.picture ? { picture: identity.picture } : {}),
  };
}

/**
 * Presence names and pictures are chosen by each client. When the socket's
 * Clerk token carried a verified name or picture, the server writes those
 * over the client's `user.name` / `user.img`, so a signed-in collaborator
 * cannot appear as someone else.
 */
export function stampVerifiedProfile(
  state: Record<string, unknown>,
  attachment: Pick<SocketAttachment, "name" | "picture">,
): Record<string, unknown> {
  if (!attachment.name && !attachment.picture) return state;
  const user = typeof state.user === "object" && state.user !== null && !Array.isArray(state.user)
    ? state.user as Record<string, unknown>
    : null;
  if (!user) return state;
  return {
    ...state,
    user: {
      ...user,
      ...(attachment.name ? { name: attachment.name } : {}),
      ...(attachment.picture ? { img: attachment.picture } : {}),
    },
  };
}
