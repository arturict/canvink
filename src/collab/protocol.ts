/**
 * Wire types and codecs for the Canvink collab-sync protocol (v1). Mirrors
 * `services/collab-sync/PROTOCOL.md` exactly; keep both in sync.
 */

/** `"workspace"` is the personal-space topology doc (PERSONAL-SYNC.md §3.3); legal only in a personal room. */
export type DocKind = 'notebook' | 'page' | 'workspace';

/**
 * What the room lets a connection do. `viewer` reads ("Lesen"); `editor` also writes; `admin` also
 * manages sharing; `owner` is the creator. The server decides it; the client never claims one.
 */
export type Role = 'owner' | 'admin' | 'editor' | 'viewer';

const ROLES: readonly Role[] = ['owner', 'admin', 'editor', 'viewer'];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** Whether the role may change documents, ink and assets of the room. */
export function roleCanWrite(role: Role | undefined): boolean {
  return role === 'owner' || role === 'admin' || role === 'editor';
}

/** Whether the role may invite, change roles, remove people and manage the link. */
export function roleCanManage(role: Role | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

export interface OwnerAuth {
  kind: 'owner';
  ownerToken: string;
}

export interface LinkAuth {
  kind: 'link';
  linkSecret: string;
}

export interface UserAuth {
  kind: 'user';
  jwt: string;
  /** Optional: omitted once the JWT subject is already a registered collaborator. */
  linkSecret?: string;
}

/** PERSONAL-SYNC.md §3.2: a personal room's only credential. Role resolves to `owner` iff the JWT `sub` matches `meta.personalSub`. */
export interface PersonalAuth {
  kind: 'personal';
  jwt: string;
}

export type AuthCredential = OwnerAuth | LinkAuth | UserAuth | PersonalAuth;

/** Highest seq per docId the client already holds, sent in `hello` to resume. */
export type SinceMap = Record<string, number>;

export interface HelloFrame {
  t: 'hello';
  auth: AuthCredential;
  since: SinceMap;
  /**
   * Personal rooms: replay only the workspace and notebook documents, plus the pages this
   * client resumes (`since`); other pages are requested with a `fetch` frame. A Worker that
   * predates the flag ignores it and replays everything, which a lazy client also accepts.
   */
  lazy?: boolean;
}

/** Asks the room for the current state of documents; answered by a `fetched` frame after the documents. */
export interface FetchFrameOut {
  t: 'fetch';
  id: string;
  docIds: string[];
  since?: SinceMap;
}

/** Client-authored `append`; the server assigns and echoes back the `seq`. */
export interface AppendFrameOut {
  t: 'append';
  docId: string;
  /** base64url-encoded Automerge incremental change bytes. */
  payload: string;
}

export interface AppendFrameIn {
  t: 'append';
  docId: string;
  payload: string;
  seq: number;
}

export interface SnapshotFrame {
  t: 'snapshot';
  docId: string;
  /** base64url-encoded full Automerge save. */
  payload: string;
  covers: number;
}

export interface AnnounceFrame {
  t: 'announce';
  docId: string;
  kind: DocKind;
}

export interface RemoveFrame {
  t: 'remove';
  docId: string;
}

export interface PingFrame {
  t: 'ping';
}

export interface PongFrame {
  t: 'pong';
}

/** The room changed this connection's role while it was open (a promotion or a demotion). */
export interface RoleFrame {
  t: 'role';
  role: Role;
}

/** PERSONAL-SYNC.md §3.4: refreshes a personal socket's JWT in-band, without reconnecting. */
export interface ReauthFrameOut {
  t: 'reauth';
  jwt: string;
}

/**
 * Ephemeral presence (PROTOCOL.md "Presence"). The server relays `state`
 * without interpreting it; its schema lives in `./presence.ts`.
 */
export interface PresenceFrameOut {
  t: 'presence';
  state: Record<string, unknown>;
}

export interface PresenceFrameIn {
  t: 'presence';
  /** Server-assigned per-socket id, stable for the socket's lifetime. */
  from: string;
  role: Role;
  /** Untrusted peer input; validate with `parsePresenceState`. */
  state: unknown;
}

export interface PresenceLeaveFrame {
  t: 'presence-leave';
  from: string;
}

export type ClientFrame =
  | PresenceFrameOut
  | HelloFrame
  | FetchFrameOut
  | AppendFrameOut
  | SnapshotFrame
  | AnnounceFrame
  | RemoveFrame
  | PingFrame
  | ReauthFrameOut;

export interface WelcomeFrame {
  t: 'welcome';
  role: Role;
  docs: Array<{ docId: string; kind: DocKind }>;
  notebookTitle: string;
  /** Set when the room honoured `hello.lazy`: pages the client holds nothing of are not replayed. */
  lazy?: boolean;
}

export interface SyncedFrame {
  t: 'synced';
}

/** Ends the documents a `fetch` asked for; `known` lists those the room has. */
export interface FetchedFrame {
  t: 'fetched';
  id?: string;
  docIds: string[];
  known: string[];
}

/** B1c: server→sender ack for an accepted `append`, used to drive periodic client-side compaction. */
export interface SeqAckFrame {
  t: 'seq';
  docId: string;
  seq: number;
}

/** PERSONAL-SYNC.md §3.4: acks a `reauth`, carrying the new grace deadline (Unix seconds). */
export interface ReauthedFrame {
  t: 'reauthed';
  expiresAt: number;
}

export type ErrorCode =
  | 'read-only'
  | 'unauthorized'
  | 'payload-too-large'
  | 'unknown-doc'
  | 'bad-frame'
  | 'quota-exceeded';

export interface ErrorFrame {
  t: 'error';
  code: ErrorCode;
  detail?: string;
}

/** Server-authored frames: `welcome`, then catch-up `snapshot`/`append`, then `synced`; live broadcasts reuse the same shapes. */
export type ServerFrame =
  | WelcomeFrame
  | SnapshotFrame
  | AppendFrameIn
  | AnnounceFrame
  | RemoveFrame
  | SyncedFrame
  | FetchedFrame
  | SeqAckFrame
  | PongFrame
  | RoleFrame
  | ErrorFrame
  | ReauthedFrame
  | PresenceFrameIn
  | PresenceLeaveFrame;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Structural validation only; does not attempt to decode base64url payloads. */
export function parseServerFrame(raw: unknown): ServerFrame {
  if (!isRecord(raw) || typeof raw.t !== 'string') {
    throw new Error('Malformed collab-sync server frame: missing "t".');
  }
  switch (raw.t) {
    case 'welcome': {
      if (
        !isRole(raw.role)
        || !Array.isArray(raw.docs)
        || typeof raw.notebookTitle !== 'string'
      ) throw new Error('Malformed "welcome" frame.');
      const docs = raw.docs.map((entry) => {
        if (!isRecord(entry) || typeof entry.docId !== 'string') throw new Error('Malformed "welcome" frame doc entry.');
        if (entry.kind === 'notebook' || entry.kind === 'page' || entry.kind === 'workspace') {
          return { docId: entry.docId, kind: entry.kind as DocKind };
        }
        // The room stores kind "unknown" for a document whose snapshot arrived before its
        // announce. One such document must not make the whole account unreadable: its id
        // names what it is.
        const inferred = entry.docId === 'workspace:root' ? 'workspace'
          : entry.docId.startsWith('notebook:') ? 'notebook'
            : entry.docId.startsWith('page:') ? 'page' : undefined;
        if (!inferred) throw new Error('Malformed "welcome" frame doc entry.');
        return { docId: entry.docId, kind: inferred as DocKind };
      });
      return { t: 'welcome', role: raw.role, docs, notebookTitle: raw.notebookTitle, ...(raw.lazy === true ? { lazy: true } : {}) };
    }
    case 'snapshot': {
      if (
        typeof raw.docId !== 'string'
        || typeof raw.payload !== 'string'
        || typeof raw.covers !== 'number'
      ) throw new Error('Malformed "snapshot" frame.');
      return { t: 'snapshot', docId: raw.docId, payload: raw.payload, covers: raw.covers };
    }
    case 'append': {
      if (
        typeof raw.docId !== 'string'
        || typeof raw.payload !== 'string'
        || typeof raw.seq !== 'number'
      ) throw new Error('Malformed "append" frame.');
      return { t: 'append', docId: raw.docId, payload: raw.payload, seq: raw.seq };
    }
    case 'announce': {
      if (
        typeof raw.docId !== 'string'
        || (raw.kind !== 'notebook' && raw.kind !== 'page' && raw.kind !== 'workspace')
      ) throw new Error('Malformed "announce" frame.');
      return { t: 'announce', docId: raw.docId, kind: raw.kind };
    }
    case 'remove': {
      if (typeof raw.docId !== 'string') throw new Error('Malformed "remove" frame.');
      return { t: 'remove', docId: raw.docId };
    }
    case 'synced':
      return { t: 'synced' };
    case 'fetched': {
      const isIds = (value: unknown): value is string[] => Array.isArray(value) && value.every((id) => typeof id === 'string');
      if (!isIds(raw.docIds) || !isIds(raw.known) || (raw.id !== undefined && typeof raw.id !== 'string')) {
        throw new Error('Malformed "fetched" frame.');
      }
      return { t: 'fetched', ...(raw.id === undefined ? {} : { id: raw.id }), docIds: raw.docIds, known: raw.known };
    }
    case 'seq': {
      if (typeof raw.docId !== 'string' || typeof raw.seq !== 'number') {
        throw new Error('Malformed "seq" frame.');
      }
      return { t: 'seq', docId: raw.docId, seq: raw.seq };
    }
    case 'pong':
      return { t: 'pong' };
    case 'role': {
      if (!isRole(raw.role)) throw new Error('Malformed "role" frame.');
      return { t: 'role', role: raw.role };
    }
    case 'presence': {
      if (
        typeof raw.from !== 'string'
        || !isRole(raw.role)
      ) throw new Error('Malformed "presence" frame.');
      return { t: 'presence', from: raw.from, role: raw.role, state: raw.state };
    }
    case 'presence-leave': {
      if (typeof raw.from !== 'string') throw new Error('Malformed "presence-leave" frame.');
      return { t: 'presence-leave', from: raw.from };
    }
    case 'reauthed': {
      if (typeof raw.expiresAt !== 'number' || !Number.isFinite(raw.expiresAt)) {
        throw new Error('Malformed "reauthed" frame.');
      }
      return { t: 'reauthed', expiresAt: raw.expiresAt };
    }
    case 'error': {
      const validCodes: ErrorCode[] = [
        'read-only',
        'unauthorized',
        'payload-too-large',
        'unknown-doc',
        'bad-frame',
        'quota-exceeded',
      ];
      if (typeof raw.code !== 'string' || !validCodes.includes(raw.code as ErrorCode)) {
        throw new Error('Malformed "error" frame.');
      }
      return {
        t: 'error',
        code: raw.code as ErrorCode,
        ...(typeof raw.detail === 'string' ? { detail: raw.detail } : {}),
      };
    }
    default:
      throw new Error(`Unknown collab-sync server frame type: ${raw.t}`);
  }
}

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** RFC 4648 §5 base64url, unpadded — matches the protocol's binary-field encoding. */
export function encodeBase64Url(bytes: Uint8Array): string {
  let result = '';
  let index = 0;
  for (; index + 2 < bytes.length; index += 3) {
    const chunk = (bytes[index] << 16) | (bytes[index + 1] << 8) | bytes[index + 2];
    result += BASE64URL_ALPHABET[(chunk >> 18) & 63];
    result += BASE64URL_ALPHABET[(chunk >> 12) & 63];
    result += BASE64URL_ALPHABET[(chunk >> 6) & 63];
    result += BASE64URL_ALPHABET[chunk & 63];
  }
  const remaining = bytes.length - index;
  if (remaining === 1) {
    const chunk = bytes[index] << 16;
    result += BASE64URL_ALPHABET[(chunk >> 18) & 63];
    result += BASE64URL_ALPHABET[(chunk >> 12) & 63];
  } else if (remaining === 2) {
    const chunk = (bytes[index] << 16) | (bytes[index + 1] << 8);
    result += BASE64URL_ALPHABET[(chunk >> 18) & 63];
    result += BASE64URL_ALPHABET[(chunk >> 12) & 63];
    result += BASE64URL_ALPHABET[(chunk >> 6) & 63];
  }
  return result;
}

const BASE64URL_VALUES = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let index = 0; index < BASE64URL_ALPHABET.length; index += 1) table[BASE64URL_ALPHABET.charCodeAt(index)] = index;
  return table;
})();

export function decodeBase64Url(text: string): Uint8Array {
  const byteLength = Math.floor((text.length * 6) / 8);
  const bytes = new Uint8Array(byteLength);
  let bitBuffer = 0;
  let bitCount = 0;
  let byteIndex = 0;
  // A table lookup per char code: replacing `indexOf` over the alphabet and the string
  // iterator made decoding a 40 MB account replay several times faster.
  for (let position = 0; position < text.length; position += 1) {
    const code = text.charCodeAt(position);
    const value = code < 128 ? BASE64URL_VALUES[code]! : -1;
    if (value === -1) throw new Error(`Invalid base64url character: ${String.fromCodePoint(text.codePointAt(position) ?? code)}`);
    bitBuffer = (bitBuffer << 6) | value;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes[byteIndex] = (bitBuffer >> bitCount) & 0xff;
      byteIndex += 1;
    }
  }
  return bytes;
}
