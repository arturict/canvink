/**
 * Room session: WebSocket transport, in-memory Automerge doc set, reconnect.
 */

import * as Automerge from '@automerge/automerge';
import { advanceHeads, isChangeSequence, readSavedDocumentHeads } from '../crdt/documentHeads';
import { SPACE_MAX_SNAPSHOT_BYTES } from '../personal-space/contract';
import {
  decodeBase64Url,
  encodeBase64Url,
  parseServerFrame,
  roleCanWrite,
  type AuthCredential,
  type ClientFrame,
  type DocKind,
  type Role,
  type SinceMap,
} from './protocol';

export type ConnectionStatus = 'connecting' | 'syncing' | 'live' | 'closed' | 'error';

/**
 * Presence traffic as seen by a `RoomSession` subscriber. `live` fires after
 * every (re)sync so a publisher can resend its own state; `reset` fires when
 * the connection drops, since every peer state is stale from then on.
 */
export type PresenceEvent =
  | { kind: 'state'; from: string; role: Role; state: unknown }
  | { kind: 'leave'; from: string }
  | { kind: 'live' }
  | { kind: 'reset' };

/** Minimal surface the session needs; the native `WebSocket` satisfies this. */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: { code: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

/** Standard WebSocket readyState value for OPEN; avoids depending on the global constructor. */
const WS_OPEN = 1;

export interface SessionCallbacks {
  onStatus(status: ConnectionStatus): void;
  onRole?(role: Role): void;
  onDocsChanged?(docId: string): void;
  onError?(error: { code: string; detail?: string }): void;
}

/** Documents one `fetch` frame asks for (the room accepts up to 64). */
const FETCH_BATCH_DOCS = 32;
/** A fetch the room does not answer in this time fails, so what waits for it does not wait forever. */
const FETCH_TIMEOUT_MS = 60_000;

/** D14: outQueue cap — frames dropped instead of growing unbounded while disconnected. */
const MAX_OUT_QUEUE_FRAMES = 1000;

export interface RoomDocEntry {
  kind: DocKind;
  /** `docStorage: 'live'` only: the merged Automerge document. */
  doc?: Automerge.Doc<unknown>;
  /**
   * `docStorage: 'bytes'` only: the compact saved room copy. It can lag behind
   * the most recently changed document for a moment; read it through
   * `RoomSession.getDocBytes`, which saves that document first.
   */
  bytes?: Uint8Array;
  /** `docStorage: 'bytes'` only: heads of the room copy, current after every frame. */
  heads?: Automerge.Heads;
  /**
   * `docStorage: 'bytes'` only: change chunks the room sent after `bytes`,
   * kept as they came so that following a document's later changes costs no
   * load. `getDocBytes` joins them to `bytes`. For a document resumed from an
   * earlier visit (`resume`) there is no `bytes` at all, since the session
   * never held the document: `delta` are then the changes the device's own
   * copy lacks.
   */
  delta?: Uint8Array;
}

/**
 * What a device already holds of the room's documents, from an earlier visit:
 * for every listed document, the room's sequence number and heads the device's
 * own copy contained. The room then only sends what came after, instead of
 * every document again.
 */
export interface RoomResume {
  docs: Record<string, { kind: DocKind; seq: number; heads: string[] }>;
}

/** How many room documents a session holds as live Automerge documents. */
export interface RoomSessionMemoryDiagnostics {
  liveDocs: number;
  storedBytes: number;
}

type MaybePromise<T> = T | Promise<T>;

function isPromiseLike<T>(value: MaybePromise<T>): value is Promise<T> {
  return typeof (value as { then?: unknown } | undefined)?.then === 'function';
}

function freeRoomDoc(doc: Automerge.Doc<unknown> | undefined): void {
  if (!doc) return;
  try {
    Automerge.free(doc);
  } catch {
    // Already freed or outdated.
  }
}

function concatBytes(first: Uint8Array, second: Uint8Array): Uint8Array {
  const joined = new Uint8Array(first.byteLength + second.byteLength);
  joined.set(first);
  joined.set(second, first.byteLength);
  return joined;
}

function sameHeadSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const set = new Set(left);
  return right.every((head) => set.has(head));
}

export interface OpenRoomSessionOptions {
  /** Worker origin, e.g. `https://collab-sync.example.workers.dev`. */
  syncUrl: string;
  roomId: string;
  auth: AuthCredential;
  /** Initial resume point; defaults to empty (fresh join). */
  since?: SinceMap;
  callbacks: SessionCallbacks;
  webSocketFactory?: WebSocketFactory;
  heartbeatIntervalMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Injectable for deterministic backoff tests; defaults to `Math.random`. */
  random?: () => number;
  /**
   * Resolves the credential to use for the next connect attempt, called
   * before every `hello` (including reconnects), so a socket that reconnects
   * after a long sleep uses a fresh JWT instead of the one captured at
   * construction. When absent, `options.auth` is used for every attempt —
   * today's behaviour, unchanged (PERSONAL-SYNC.md §5.3).
   */
  getAuth?(): Promise<AuthCredential>;
  /**
   * `'queue'` (default) reproduces today's behaviour: `sendLocalChange`
   * always enqueues while disconnected, subject to the D14 cap. `'snapshot'`
   * implements PERSONAL-SYNC.md P7/§5.3: while not `'live'`, `sendLocalChange`
   * only records the docId as dirty; on `synced` one full snapshot per dirty
   * doc is sent instead of replaying queued appends.
   *
   * `'reconcile'` is for a writer whose local documents are persisted (the
   * owner's workspace): while not `'live'`, `sendLocalChange` drops the
   * change instead of queueing it, and after every `synced` the binding
   * sends whatever the room lacks, computed against `getConfirmedHeads`
   * (see `bindEditorSession`). Unlike the in-memory queue this survives a
   * reload while offline, and nothing is dropped past a queue cap.
   */
  resyncStrategy?: 'queue' | 'snapshot' | 'reconcile';
  /**
   * Source of the browser's `online` event (defaults to `window` where it
   * exists). When the device is back on a network, a pending reconnect runs
   * at once instead of waiting out the backoff, which can reach
   * `maxBackoffMs` after a long time offline. `null` disables this.
   */
  networkEvents?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> | null;
  /**
   * Required when `resyncStrategy === 'snapshot'`: returns the full Automerge
   * save for a docId, or `undefined` if not yet available (retried on the next
   * resync). May resolve asynchronously (a page that is not loaded is read
   * from storage); dirty documents are then flushed one after the other.
   */
  getFullSnapshotBytes?(docId: string): MaybePromise<Uint8Array | undefined>;
  /**
   * `'live'` (default) keeps a merged Automerge document per room doc, which
   * viewers render from. `'bytes'` is for an owner whose persisted workspace
   * is the real copy: each room doc is kept as its compact saved bytes plus
   * heads, and incoming frames are merged by loading the bytes, applying the
   * frame, saving and freeing again. Only the most recently changed document
   * stays loaded, for `hotDocIdleMs`, so a burst of frames for one page is
   * not loaded and saved once per frame. `getDoc` returns `undefined` in this
   * mode; use `getDocBytes` and `getConfirmedHeads`.
   */
  docStorage?: 'live' | 'bytes';
  /** `docStorage: 'bytes'` only: how long the last changed doc stays loaded. Default 1000 ms. */
  hotDocIdleMs?: number;
  /** `docStorage: 'bytes'` only: documents the device already holds (see `RoomResume`). */
  resume?: RoomResume;
  /** How long a `fetchDocs` request may wait for the room's answer; default one minute. */
  fetchTimeoutMs?: number;
  /**
   * `docStorage: 'bytes'` only: ask the room to leave out page documents the device
   * holds nothing of. They are requested one batch at a time with `fetchDocs`, so the
   * workspace and notebooks are there long before the pages are.
   */
  lazyPages?: boolean;
}

export interface RoomSession {
  getStatus(): ConnectionStatus;
  getRole(): Role | undefined;
  getDocs(): ReadonlyMap<string, RoomDocEntry>;
  /** The merged room document (`docStorage: 'live'` only; `undefined` in `'bytes'` mode). */
  getDoc(docId: string): Automerge.Doc<unknown> | undefined;
  /** A full Automerge save of the room's copy of a doc, in either storage mode. */
  getDocBytes(docId: string): Uint8Array | undefined;
  getMemoryDiagnostics(): RoomSessionMemoryDiagnostics;
  /**
   * `docStorage: 'bytes'` only: the documents whose room state is known by
   * heads and sequence number, to resume from on the next visit.
   */
  getResumeState(): RoomResume;
  /**
   * `lazyPages` only: asks the room for these documents (the ones this session holds nothing of)
   * and resolves once it sent them; rejects when the connection is not live or drops meanwhile.
   * Each document then arrives like any other room document (`onDocsChanged`).
   */
  fetchDocs(docIds: readonly string[]): Promise<void>;
  /** Whether the session holds content (bytes or heads) of a room document. */
  holdsDoc(docId: string): boolean;
  /**
   * `lazyPages` only: the room has the document but has not sent it (nobody asked for it yet, or
   * the answer is still on its way), so what the room holds of it is unknown here (as opposed to
   * a document the room holds no content of).
   */
  awaitsFetch(docId: string): boolean;
  sendLocalChange(docId: string, bytes: Uint8Array): void;
  sendSnapshot(docId: string, bytes: Uint8Array, covers: number): void;
  /**
   * Sends `bytes` as the room's new snapshot of a document that shares no history with the one the room
   * holds (a rewrite of it without its history), and keeps them as this session's copy instead of merging
   * them into the old one (`docStorage: 'bytes'`; otherwise it is `sendSnapshot`). `covers` is the newest
   * change `getDocSeq` knew of: the room drops the changes up to it. Devices that still hold the old
   * document merge both until they reload it.
   */
  replaceDoc(docId: string, bytes: Uint8Array, covers: number): void;
  /** The newest room sequence number this session applied for a document. */
  getDocSeq(docId: string): number | undefined;
  /**
   * `docStorage: 'bytes'`, workspace documents only: what reached this session for the document since the
   * last call. `full` means the copy was replaced or its changes cannot be told (a snapshot arrived, or a
   * frame could not be followed), and the caller reads `getDocBytes`; otherwise `changes` are the change
   * chunks that were appended, which a copy that held everything before applies with `loadIncremental`
   * instead of loading the whole document again, and nothing at all means nothing arrived.
   */
  takeDocUpdates(docId: string): { full: boolean; changes?: Uint8Array };
  announceDoc(docId: string, kind: DocKind): void;
  removeDoc(docId: string): void;
  /** Fires after the initial `onDocsChanged` callback, for listeners attached post-construction. */
  subscribeDocsChanged(listener: (docId: string) => void): () => void;
  /** B1c: fires once per server `seq` ack for an append this session sent. Drives client-side compaction (see `attachAckCompaction`). */
  subscribeAcked(listener: (docId: string, seq: number) => void): () => void;
  /** PERSONAL-SYNC.md §3.4: refreshes this socket's JWT in-band. No-op shape on a socket the server treats as shared — the frame is simply ignored server-side. */
  sendReauth(jwt: string): void;
  /** Fires on every server `reauthed` ack, with the new grace deadline (Unix seconds). */
  subscribeReauthed(listener: (expiresAt: number) => void): () => void;
  /** Fires after each catch-up completed (`synced`), once queued frames went out. */
  subscribeSynced(listener: () => void): () => void;
  /**
   * Heads of what the room is known to hold for a doc (catch-up, broadcasts
   * and, with `'reconcile'` or `docStorage: 'bytes'`, this session's own
   * acknowledged appends), or undefined when the room has no content for it yet.
   */
  getConfirmedHeads(docId: string): Automerge.Heads | undefined;
  /**
   * Sends an ephemeral presence state. Never queued: while the socket is not
   * live, or once the server has shown it does not know presence, the state
   * is dropped and `false` is returned. The next `live` event is the moment
   * to publish again.
   */
  sendPresence(state: Record<string, unknown>): boolean;
  subscribePresence(listener: (event: PresenceEvent) => void): () => void;
  close(): void;
}

function toWebSocketUrl(syncUrl: string, roomId: string): string {
  const httpUrl = new URL(`/api/v1/rooms/${encodeURIComponent(roomId)}/ws`, syncUrl);
  httpUrl.protocol = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  return httpUrl.toString();
}

function defaultWebSocketFactory(url: string): WebSocketLike {
  const GlobalWebSocket = (globalThis as { WebSocket?: new (target: string) => WebSocketLike }).WebSocket;
  if (!GlobalWebSocket) {
    throw new Error('No global WebSocket is available; pass options.webSocketFactory.');
  }
  return new GlobalWebSocket(url);
}

/**
 * Connects a room, maintains an in-memory Automerge doc set, and reconnects
 * with exponential backoff. The server never echoes a frame back to its
 * sender (PROTOCOL.md: "broadcast to all other connected sessions"), so
 * applying every incoming frame to the local doc set never double-applies a
 * change this session itself produced.
 */
export function openRoomSession(options: OpenRoomSessionOptions): RoomSession {
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 25_000;
  const minBackoffMs = options.minBackoffMs ?? 1_000;
  const maxBackoffMs = options.maxBackoffMs ?? 30_000;
  const random = options.random ?? Math.random;
  const webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;

  const resyncStrategy = options.resyncStrategy ?? 'queue';
  const bytesMode = options.docStorage === 'bytes';
  const hotDocIdleMs = options.hotDocIdleMs ?? 1_000;
  /** Own appends are folded into the room copy on their ack (see `confirmOwnAppend`). */
  const tracksOwnAppends = resyncStrategy === 'reconcile' || bytesMode;

  const docs = new Map<string, RoomDocEntry>();
  const since: SinceMap = { ...(options.since ?? {}) };
  /** Resumed documents whose room state could not be followed; the next connection fetches them whole. */
  const brokenResume = new Set<string>();
  if (bytesMode && options.resume) {
    for (const [docId, resumed] of Object.entries(options.resume.docs)) {
      docs.set(docId, { kind: resumed.kind, heads: [...resumed.heads] });
      since[docId] = resumed.seq;
    }
  }
  const lazyPages = bytesMode && options.lazyPages === true;
  /** Set by the room's welcome when it honours `lazyPages`; an older room replays everything, and that is accepted as it comes. */
  let serverLazy = false;
  /** Documents asked for with `fetchDocs`; their frames are wanted even though nothing of them is held yet. */
  const wanted = new Set<string>();
  /** Documents whose `fetch` was answered; until then what the room holds of them is not known here. */
  const fetchAnswered = new Set<string>();
  const pendingFetches = new Map<string, { docIds: string[]; resolve(): void; reject(error: Error): void }>();
  const fetchTimeoutMs = options.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;
  let fetchCounter = 0;
  const holds = (docId: string): boolean => {
    const entry = docs.get(docId);
    return entry !== undefined && (entry.bytes !== undefined || entry.heads !== undefined || entry.delta !== undefined);
  };
  /** A lazy room does not send pages that were not asked for; a frame for one (a peer's live change) has no base here. */
  const isUnwantedPageFrame = (docId: string): boolean =>
    lazyPages && serverLazy && docs.get(docId)?.kind === 'page' && !wanted.has(docId) && !holds(docId);
  const failPendingFetches = (message: string): void => {
    const pending = [...pendingFetches.values()];
    pendingFetches.clear();
    for (const fetch of pending) {
      for (const docId of fetch.docIds) if (!holds(docId)) wanted.delete(docId);
      fetch.reject(new Error(message));
    }
  };
  const docsChangedListeners = new Set<(docId: string) => void>();
  const ackedListeners = new Set<(docId: string, seq: number) => void>();
  const reauthedListeners = new Set<(expiresAt: number) => void>();
  const presenceListeners = new Set<(event: PresenceEvent) => void>();
  const syncedListeners = new Set<() => void>();
  /**
   * `'reconcile'` only: this session's appends awaiting their `seq` ack, per
   * doc, in send order. The server acks each accepted append in order, so an
   * ack applies the oldest pending payload to the confirmed doc.
   */
  const pendingOwn = new Map<string, Uint8Array[]>();
  /** Cleared when a server predating presence rejects the frame type. */
  let presenceSupported = true;
  let presenceSent = false;
  /** P7 (`resyncStrategy === 'snapshot'` only): docIds with local changes made while not `'live'`. */
  const dirtyDocIds = new Set<string>();
  /**
   * `docStorage: 'bytes'` only: the one room doc currently loaded, and
   * whether it changed since its bytes were last saved into its entry.
   */
  let hot: { docId: string; doc: Automerge.Doc<unknown>; dirty: boolean } | undefined;
  let hotTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * `docStorage: 'bytes'` only: docs whose room copy holds a snapshot this
   * session sent itself and the room never confirmed (no seq for them yet).
   * The room never echoes it back, so without folding it in, a peer's later
   * appends for a doc this device uploaded would lack their base here.
   */
  const ownSnapshotDocIds = new Set<string>();
  /**
   * `docStorage: 'bytes'` only: change chunks appended to a document that `entry.heads` do not account
   * for yet. Working the heads out of a chunk decodes every operation in it (seconds for the big
   * changes a workspace document receives in a replay), so it waits until somebody asks for the heads
   * (`currentHeads`); a document that only receives changes is never decoded.
   */
  const unaccountedChanges = new Map<string, Uint8Array[]>();
  const currentHeads = (docId: string): string[] | undefined => {
    const entry = docs.get(docId);
    if (!entry) return undefined;
    const pending = unaccountedChanges.get(docId);
    if (!pending) return entry.heads ? [...entry.heads] : undefined;
    unaccountedChanges.delete(docId);
    let heads: string[] | undefined = entry.heads ?? [];
    for (const chunk of pending) {
      heads = advanceHeads(heads, chunk);
      if (!heads) break;
    }
    if (heads) {
      docs.set(docId, { ...entry, heads });
      return [...heads];
    }
    // A chunk the heads cannot be followed through: the copy is kept, its heads are unknown.
    const { heads: _unknown, ...withoutHeads } = entry;
    void _unknown;
    docs.set(docId, withoutHeads);
    return undefined;
  };
  /** Workspace documents only: what arrived since `takeDocUpdates` was last asked. */
  const pendingUpdates = new Map<string, { full: boolean; chunks: Uint8Array[]; size: number }>();
  const MAX_PENDING_UPDATE_BYTES = 16 * 1024 * 1024;
  const recordFullUpdate = (docId: string): void => {
    if (docs.get(docId)?.kind === 'workspace') pendingUpdates.set(docId, { full: true, chunks: [], size: 0 });
  };
  const recordAppendedChanges = (docId: string, bytes: Uint8Array): void => {
    if (docs.get(docId)?.kind !== 'workspace') return;
    const pending = pendingUpdates.get(docId) ?? { full: false, chunks: [], size: 0 };
    pendingUpdates.set(docId, pending);
    if (pending.full) return;
    pending.chunks.push(bytes);
    pending.size += bytes.byteLength;
    if (pending.size > MAX_PENDING_UPDATE_BYTES) {
      pending.full = true;
      pending.chunks = [];
      pending.size = 0;
    }
  };

  /** Saves the loaded room doc into its entry (when it changed) and frees it. */
  const settleHotDoc = (): void => {
    if (hotTimer !== undefined) {
      clearTimeout(hotTimer);
      hotTimer = undefined;
    }
    const current = hot;
    hot = undefined;
    if (!current) return;
    const entry = docs.get(current.docId);
    if (entry && current.dirty) {
      try {
        entry.bytes = Automerge.save(current.doc);
      } catch {
        // A frame that failed half-way left the doc unusable; the older bytes stay.
      }
    }
    freeRoomDoc(current.doc);
  };

  const dropHotDoc = (docId: string): void => {
    if (hot?.docId !== docId) return;
    if (hotTimer !== undefined) clearTimeout(hotTimer);
    hotTimer = undefined;
    freeRoomDoc(hot.doc);
    hot = undefined;
  };

  /**
   * `docStorage: 'bytes'`: runs `update` on the room copy of `docId`, loaded
   * from its bytes unless it is the doc already loaded. `update` returns the
   * new doc and, when the doc was created from a complete save that nothing
   * else changed, those bytes (so they need not be saved again).
   */
  const updateStoredDoc = (
    docId: string,
    kind: DocKind,
    update: (base: Automerge.Doc<unknown> | undefined) => { doc: Automerge.Doc<unknown>; cleanBytes?: Uint8Array },
  ): void => {
    if (hot && hot.docId !== docId) settleHotDoc();
    const entry = docs.get(docId) ?? { kind };
    const base = hot?.docId === docId
      ? hot.doc
      : entry.bytes ? Automerge.load<unknown>(entry.delta ? concatBytes(entry.bytes, entry.delta) : entry.bytes) : undefined;
    const beforeHeads = base ? Automerge.getHeads(base) : [];
    let result: { doc: Automerge.Doc<unknown>; cleanBytes?: Uint8Array };
    try {
      result = update(base);
    } catch (error) {
      if (hot?.docId === docId) dropHotDoc(docId);
      else freeRoomDoc(base);
      throw error;
    }
    const heads = Automerge.getHeads(result.doc);
    const changed = !sameHeadSet(beforeHeads, heads);
    const wasDirty = hot?.docId === docId && hot.dirty;
    if (result.cleanBytes && !base) entry.bytes = result.cleanBytes;
    const stored: RoomDocEntry = { ...entry, kind, heads };
    // The loaded document contains the delta now.
    delete stored.delta;
    docs.set(docId, stored);
    unaccountedChanges.delete(docId);
    hot = { docId, doc: result.doc, dirty: wasDirty || (changed && !(result.cleanBytes && !base)) };
    if (hotTimer !== undefined) clearTimeout(hotTimer);
    hotTimer = setTimeout(settleHotDoc, hotDocIdleMs);
  };

  const notifyDocsChanged = (docId: string): void => {
    options.callbacks.onDocsChanged?.(docId);
    for (const listener of docsChangedListeners) listener(docId);
  };

  const notifyAcked = (docId: string, seq: number): void => {
    for (const listener of ackedListeners) listener(docId, seq);
  };

  const notifyReauthed = (expiresAt: number): void => {
    for (const listener of reauthedListeners) listener(expiresAt);
  };

  const notifyPresence = (event: PresenceEvent): void => {
    for (const listener of presenceListeners) {
      try {
        listener(event);
      } catch {
        // A broken presence renderer must never break document sync.
      }
    }
  };

  let socket: WebSocketLike | undefined;
  let status: ConnectionStatus = 'connecting';
  let role: Role | undefined;
  /**
   * A reader never writes: the room would refuse the frame, and a demoted editor must not keep
   * sending what it queued as an editor. Until the welcome tells the role nothing is held back.
   */
  const readOnly = (): boolean => role !== undefined && !roleCanWrite(role);
  let synced = false;
  let fatal = false;
  let disposed = false;
  let backoffMs = minBackoffMs;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let outQueue: string[] = [];

  const setStatus = (next: ConnectionStatus): void => {
    const wasLive = status === 'live';
    status = next;
    options.callbacks.onStatus(next);
    if (wasLive && next !== 'live') notifyPresence({ kind: 'reset' });
  };

  const setSeq = (docId: string, seq: number): void => {
    if (!since[docId] || since[docId] < seq) since[docId] = seq;
  };

  const send = (frame: ClientFrame): void => {
    const text = JSON.stringify(frame);
    if (socket && socket.readyState === WS_OPEN && synced) {
      socket.send(text);
    } else {
      enqueue(text);
    }
  };

  const flushQueue = (): void => {
    if (!socket || socket.readyState !== WS_OPEN) return;
    const pending = outQueue;
    outQueue = [];
    for (const text of pending) socket.send(text);
  };

  /**
   * P7: called once per `synced` transition when `resyncStrategy ===
   * 'snapshot'`. Sends one full snapshot per doc marked dirty while
   * disconnected, `covers = since[docId] ?? 0` (PERSONAL-SYNC.md §5.3).
   * `announce`/`remove` frames are unaffected — they went through the normal
   * queue and were already flushed by `flushQueue()` before this runs.
   */
  const flushDirtyDocs = (): void => {
    const pending = [...dirtyDocIds];
    dirtyDocIds.clear();
    const sendDirtySnapshot = (docId: string, bytes: Uint8Array | undefined): void => {
      if (!bytes) {
        // Not available yet (e.g. catch-up still running); retry on the next resync.
        dirtyDocIds.add(docId);
        return;
      }
      if (bytes.byteLength > SPACE_MAX_SNAPSHOT_BYTES) {
        options.callbacks.onError?.({
          code: 'quota-exceeded',
          detail: `Snapshot for ${docId} exceeds the ${SPACE_MAX_SNAPSHOT_BYTES}-byte limit; sync stopped for this document.`,
        });
        return;
      }
      send({ t: 'snapshot', docId, payload: encodeBase64Url(bytes), covers: since[docId] ?? 0 });
    };
    // Synchronous sources are flushed in one go; an asynchronous one (a page
    // read from storage) is awaited document by document, so only one
    // unloaded page is in memory at a time.
    const flushFrom = (index: number): void => {
      for (let position = index; position < pending.length; position += 1) {
        const docId = pending[position]!;
        const result = options.getFullSnapshotBytes?.(docId);
        if (isPromiseLike(result)) {
          result.then(
            (bytes) => {
              if (disposed) return;
              sendDirtySnapshot(docId, bytes);
              flushFrom(position + 1);
            },
            () => {
              if (disposed) return;
              dirtyDocIds.add(docId);
              flushFrom(position + 1);
            },
          );
          return;
        }
        sendDirtySnapshot(docId, result);
      }
    };
    flushFrom(0);
  };

  /** D14: bounded queue — drop the oldest frame rather than growing unbounded while offline. */
  const enqueue = (text: string): void => {
    if (outQueue.length >= MAX_OUT_QUEUE_FRAMES) {
      outQueue.shift();
      options.callbacks.onError?.({
        code: 'bad-frame',
        detail: 'Outgoing collab-sync queue is full; dropped the oldest pending frame.',
      });
    }
    outQueue.push(text);
  };

  const stopHeartbeat = (): void => {
    if (heartbeatTimer !== undefined) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
  };

  const startHeartbeat = (): void => {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (socket && socket.readyState === WS_OPEN) {
        socket.send(JSON.stringify({ t: 'ping' }));
      }
    }, heartbeatIntervalMs);
  };

  const scheduleReconnect = (): void => {
    if (disposed || fatal) return;
    const jitter = random() * backoffMs * 0.2;
    const delay = Math.min(backoffMs, maxBackoffMs) + jitter;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
      connect();
    }, delay);
  };

  const applyAnnounce = (docId: string, kind: DocKind): void => {
    if (!docs.has(docId)) docs.set(docId, { kind });
    notifyDocsChanged(docId);
  };

  /**
   * B1b: MERGE the loaded snapshot into any doc already held in memory,
   * rather than replacing it outright. Defense in depth against B1: even if
   * the server ever resends a snapshot the client already covers (or a
   * buggy/hostile peer sends one), merging is idempotent and never discards
   * local Automerge history the client already has — a plain replace would
   * silently drop every change made since the snapshot was taken.
   */
  const applySnapshot = (docId: string, kind: DocKind, payload: string, covers: number): void => {
    const bytes = decodeBase64Url(payload);
    if (bytesMode && hot?.docId !== docId && !docs.get(docId)?.bytes) {
      // A document this session holds nothing of yet: keep the save as it came.
      // Loading it would build the whole object tree just to learn its heads,
      // which sit at a fixed place in the save. The runtime validates the
      // bytes when it adopts or merges them.
      const heads = readSavedDocumentHeads(bytes);
      if (heads) {
        docs.set(docId, { kind, bytes, heads });
        unaccountedChanges.delete(docId);
        recordFullUpdate(docId);
        setSeq(docId, covers);
        notifyDocsChanged(docId);
        return;
      }
    }
    const loaded = Automerge.load<unknown>(bytes);
    if (bytesMode) {
      updateStoredDoc(docId, kind, (base) => {
        if (!base) return { doc: loaded, cleanBytes: bytes };
        const merged = Automerge.merge(base, loaded);
        freeRoomDoc(loaded);
        return { doc: merged };
      });
    } else {
      const entry = docs.get(docId);
      const merged = entry?.doc ? Automerge.merge(entry.doc, loaded) : loaded;
      docs.set(docId, { kind, doc: merged });
    }
    recordFullUpdate(docId);
    setSeq(docId, covers);
    notifyDocsChanged(docId);
  };

  /** A document the session can follow by heads alone: it has heads and is not the loaded one. */
  const canFollowByHeads = (docId: string): boolean => {
    const entry = docs.get(docId);
    return bytesMode && entry?.heads !== undefined && hot?.docId !== docId;
  };

  /** Forgets what was resumed for a document, so that the next connection sends it whole. */
  const breakResume = (docId: string): void => {
    const entry = docs.get(docId);
    if (entry) docs.set(docId, { kind: entry.kind });
    unaccountedChanges.delete(docId);
    recordFullUpdate(docId);
    delete since[docId];
    brokenResume.add(docId);
  };

  const applyAppend = (docId: string, payload: string, seq: number): void => {
    const entry = docs.get(docId);
    if (canFollowByHeads(docId) && entry) {
      // The change chunks are kept as they came and the heads follow from them, so
      // a document that only receives changes is never loaded.
      const bytes = decodeBase64Url(payload);
      if (!isChangeSequence(bytes)) {
        breakResume(docId);
        return;
      }
      docs.set(docId, { ...entry, delta: entry.delta ? concatBytes(entry.delta, bytes) : bytes });
      unaccountedChanges.set(docId, [...(unaccountedChanges.get(docId) ?? []), bytes]);
      recordAppendedChanges(docId, bytes);
      setSeq(docId, seq);
      notifyDocsChanged(docId);
      return;
    }
    if (bytesMode) {
      const bytes = decodeBase64Url(payload);
      updateStoredDoc(docId, entry?.kind ?? 'page', (base) => ({
        doc: Automerge.loadIncremental(base ?? Automerge.init<unknown>(), bytes),
      }));
      recordAppendedChanges(docId, bytes);
    } else {
      const base = entry?.doc ?? Automerge.init<unknown>();
      const merged = Automerge.loadIncremental(base, decodeBase64Url(payload));
      docs.set(docId, { kind: entry?.kind ?? 'page', doc: merged });
    }
    setSeq(docId, seq);
    notifyDocsChanged(docId);
  };

  /**
   * `'reconcile'`: the room accepted our append as `seq`. Folding it into the
   * confirmed doc (without a docs-changed notification, it is not news to
   * this device) and advancing `since` is safe because the Durable Object
   * handles frames serially: every change with a lower seq was broadcast to
   * this socket before this ack.
   */
  const confirmOwnAppend = (docId: string, seq: number): void => {
    const queue = pendingOwn.get(docId);
    const bytes = queue?.shift();
    if (queue && queue.length === 0) pendingOwn.delete(docId);
    const entry = docs.get(docId);
    if (bytes && entry && canFollowByHeads(docId)) {
      if (!isChangeSequence(bytes)) {
        breakResume(docId);
        setSeq(docId, seq);
        return;
      }
      // A resumed document has no room copy here: the device's own copy has these changes already.
      if (entry.bytes !== undefined) docs.set(docId, { ...entry, delta: entry.delta ? concatBytes(entry.delta, bytes) : bytes });
      unaccountedChanges.set(docId, [...(unaccountedChanges.get(docId) ?? []), bytes]);
    } else if (bytes && entry) {
      try {
        if (bytesMode) {
          updateStoredDoc(docId, entry.kind, (base) => ({
            doc: Automerge.loadIncremental(base ?? Automerge.init<unknown>(), bytes),
          }));
        } else {
          docs.set(docId, { kind: entry.kind, doc: Automerge.loadIncremental(entry.doc ?? Automerge.init<unknown>(), bytes) });
        }
      } catch {
        // Our own bytes; if they cannot be applied the next reconcile resends them.
      }
    }
    setSeq(docId, seq);
  };

  const applyRemove = (docId: string): void => {
    dropHotDoc(docId);
    pendingUpdates.delete(docId);
    unaccountedChanges.delete(docId);
    if (docs.delete(docId)) notifyDocsChanged(docId);
    delete since[docId];
  };

  const handleMessage = (raw: unknown): void => {
    let frame;
    try {
      const text = typeof raw === 'string' ? raw : String(raw);
      frame = parseServerFrame(JSON.parse(text));
    } catch (error) {
      options.callbacks.onError?.({ code: 'bad-frame', detail: (error as Error).message });
      return;
    }
    switch (frame.t) {
      case 'welcome': {
        role = frame.role;
        if (readOnly()) outQueue = [];
        serverLazy = lazyPages && frame.lazy === true;
        fetchAnswered.clear();
        options.callbacks.onRole?.(frame.role);
        // An uploaded snapshot the room never confirmed may have been lost with
        // the connection: forget it, so the catch-up and the next reconcile
        // decide again what the room holds.
        for (const docId of ownSnapshotDocIds) {
          if (since[docId] !== undefined) continue;
          dropHotDoc(docId);
          const entry = docs.get(docId);
          if (entry) docs.set(docId, { kind: entry.kind });
        }
        ownSnapshotDocIds.clear();
        const welcomeIds = new Set(frame.docs.map((entry) => entry.docId));
        for (const docId of [...docs.keys()]) {
          if (!welcomeIds.has(docId)) applyRemove(docId);
        }
        for (const entry of frame.docs) {
          if (!docs.has(entry.docId)) docs.set(entry.docId, { kind: entry.kind });
        }
        setStatus('syncing');
        break;
      }
      case 'snapshot': {
        if (isUnwantedPageFrame(frame.docId)) break;
        // D8: a hostile/broken peer's base64 or Automerge bytes must not
        // crash every session that receives them. Skip the frame and report
        // a non-fatal error instead of letting the exception propagate into
        // the WebSocket's onmessage handler.
        try {
          const kind = docs.get(frame.docId)?.kind ?? 'page';
          applySnapshot(frame.docId, kind, frame.payload, frame.covers);
        } catch (error) {
          options.callbacks.onError?.({
            code: 'bad-frame',
            detail: `Malformed snapshot for ${frame.docId}: ${(error as Error).message}`,
          });
        }
        break;
      }
      case 'append':
        if (isUnwantedPageFrame(frame.docId)) break;
        try {
          applyAppend(frame.docId, frame.payload, frame.seq);
        } catch (error) {
          options.callbacks.onError?.({
            code: 'bad-frame',
            detail: `Malformed append for ${frame.docId}: ${(error as Error).message}`,
          });
        }
        break;
      case 'announce':
        applyAnnounce(frame.docId, frame.kind);
        break;
      case 'remove':
        applyRemove(frame.docId);
        break;
      case 'fetched': {
        const pending = frame.id === undefined ? undefined : pendingFetches.get(frame.id);
        if (frame.id !== undefined) pendingFetches.delete(frame.id);
        for (const docId of frame.docIds) fetchAnswered.add(docId);
        if (pending) pending.resolve();
        break;
      }
      case 'seq':
        if (tracksOwnAppends) confirmOwnAppend(frame.docId, frame.seq);
        notifyAcked(frame.docId, frame.seq);
        break;
      case 'synced':
        synced = true;
        backoffMs = minBackoffMs;
        setStatus('live');
        flushQueue();
        if (resyncStrategy === 'snapshot') flushDirtyDocs();
        for (const listener of syncedListeners) listener();
        notifyPresence({ kind: 'live' });
        if (brokenResume.size > 0) {
          // A connection with the corrected resume point fetches those documents whole.
          brokenResume.clear();
          socket?.close();
        }
        break;
      case 'pong':
        break;
      case 'role':
        // A promotion or a demotion while the socket is open; the room enforces it on its side too.
        role = frame.role;
        if (readOnly()) outQueue = [];
        options.callbacks.onRole?.(frame.role);
        break;
      case 'reauthed':
        notifyReauthed(frame.expiresAt);
        break;
      case 'presence':
        notifyPresence({ kind: 'state', from: frame.from, role: frame.role, state: frame.state });
        break;
      case 'presence-leave':
        notifyPresence({ kind: 'leave', from: frame.from });
        break;
      case 'error':
        if (presenceSent && frame.code === 'bad-frame' && frame.detail === 'unknown frame type') {
          // A deployed Worker older than presence: stop sending it for this
          // session instead of producing one error per pointer move.
          presenceSupported = false;
          break;
        }
        if (frame.code === 'unauthorized') {
          fatal = true;
          setStatus('error');
        }
        options.callbacks.onError?.({ code: frame.code, detail: frame.detail });
        break;
    }
  };

  /** Opens the socket with an already-resolved credential. Split out of `connect()` so the no-`getAuth` path stays fully synchronous — required for `resyncStrategy: 'queue'`-equivalent, today's, behaviour. */
  const openSocket = (auth: AuthCredential): void => {
    if (disposed || fatal) return;
    const ws = webSocketFactory(toWebSocketUrl(options.syncUrl, options.roomId));
    socket = ws;
    ws.onopen = () => {
      const hello: ClientFrame = { t: 'hello', auth, since: { ...since }, ...(lazyPages ? { lazy: true } : {}) };
      ws.send(JSON.stringify(hello));
      startHeartbeat();
    };
    ws.onmessage = (event) => handleMessage(event.data);
    ws.onerror = () => {
      options.callbacks.onError?.({ code: 'bad-frame', detail: 'WebSocket transport error.' });
    };
    ws.onclose = (event) => {
      stopHeartbeat();
      if (socket === ws) socket = undefined;
      // Unacknowledged appends have an unknown fate; the catch-up after the
      // reconnect tells, and the reconcile resends what is still missing.
      pendingOwn.clear();
      failPendingFetches('The room connection closed before the documents arrived.');
      if (event.code === 4401) fatal = true;
      if (disposed) return;
      if (fatal) {
        setStatus('closed');
        return;
      }
      setStatus('connecting');
      scheduleReconnect();
    };
  };

  /**
   * Called before every connect attempt (initial connect and every
   * reconnect). When `options.getAuth` is absent this resolves synchronously
   * to `options.auth`, matching today's behaviour exactly. When present, it
   * is awaited so a reconnect after a long sleep uses a fresh credential
   * (PERSONAL-SYNC.md §5.3) rather than the one captured at construction.
   */
  const connect = (): void => {
    if (disposed || fatal) return;
    synced = false;
    setStatus('connecting');
    if (!options.getAuth) {
      openSocket(options.auth);
      return;
    }
    options.getAuth().then(
      (auth) => openSocket(auth),
      (error: unknown) => {
        if (disposed || fatal) return;
        options.callbacks.onError?.({
          code: 'bad-frame',
          detail: `getAuth() failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        setStatus('connecting');
        scheduleReconnect();
      },
    );
  };

  const networkEvents = options.networkEvents === undefined
    ? (typeof window !== 'undefined' ? window : null)
    : options.networkEvents;
  const onOnline = (): void => {
    if (disposed || fatal || reconnectTimer === undefined) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    backoffMs = minBackoffMs;
    connect();
  };
  networkEvents?.addEventListener('online', onOnline);

  connect();

  const api: RoomSession = {
    getStatus: () => status,
    getRole: () => role,
    getDocs: () => docs,
    getDoc: (docId) => docs.get(docId)?.doc,
    getDocBytes: (docId) => {
      const entry = docs.get(docId);
      if (!entry) return undefined;
      if (!bytesMode) return entry.doc ? Automerge.save(entry.doc) : undefined;
      if (hot?.docId === docId && hot.dirty) {
        entry.bytes = Automerge.save(hot.doc);
        hot.dirty = false;
      }
      if (entry.bytes && entry.delta) {
        entry.bytes = concatBytes(entry.bytes, entry.delta);
        delete entry.delta;
      }
      return entry.bytes ?? entry.delta;
    },
    getMemoryDiagnostics: () => {
      let liveDocs = 0;
      let storedBytes = 0;
      for (const entry of docs.values()) {
        if (entry.doc) liveDocs += 1;
        storedBytes += (entry.bytes?.byteLength ?? 0) + (entry.delta?.byteLength ?? 0);
      }
      return { liveDocs: liveDocs + (hot ? 1 : 0), storedBytes };
    },
    getResumeState: () => {
      const resumed: RoomResume['docs'] = {};
      for (const [docId, entry] of docs) {
        const seq = since[docId];
        // A document with changes the heads do not account for yet is left out until they do.
        if (!bytesMode || !entry.heads || unaccountedChanges.has(docId) || seq === undefined) continue;
        resumed[docId] = { kind: entry.kind, seq, heads: [...entry.heads] };
      }
      return { docs: resumed };
    },
    fetchDocs: (docIds) => {
      if (!synced || status !== 'live' || !socket || socket.readyState !== WS_OPEN) {
        return Promise.reject(new Error('The room connection is not live.'));
      }
      // An older room already sent every page with the catch-up.
      const wantedNow = [...new Set(docIds)].filter((docId) => docs.has(docId) && !holds(docId));
      if (!serverLazy || wantedNow.length === 0) return Promise.resolve();
      const requests: Promise<void>[] = [];
      for (let offset = 0; offset < wantedNow.length; offset += FETCH_BATCH_DOCS) {
        const batch = wantedNow.slice(offset, offset + FETCH_BATCH_DOCS);
        fetchCounter += 1;
        const id = String(fetchCounter);
        for (const docId of batch) wanted.add(docId);
        requests.push(new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            if (!pendingFetches.delete(id)) return;
            for (const docId of batch) if (!holds(docId)) wanted.delete(docId);
            reject(new Error('The room did not answer the fetch in time.'));
          }, fetchTimeoutMs);
          pendingFetches.set(id, {
            docIds: batch,
            resolve: () => { clearTimeout(timer); resolve(); },
            reject: (error) => { clearTimeout(timer); reject(error); },
          });
          socket?.send(JSON.stringify({ t: 'fetch', id, docIds: batch, since: Object.fromEntries(batch.flatMap((docId) => (since[docId] === undefined ? [] : [[docId, since[docId]] as const]))) } satisfies ClientFrame));
        }));
      }
      return Promise.all(requests).then(() => undefined);
    },
    holdsDoc: holds,
    awaitsFetch: (docId) => serverLazy && docs.has(docId) && !holds(docId) && !fetchAnswered.has(docId),
    sendLocalChange: (docId, bytes) => {
      if (readOnly()) return;
      if (resyncStrategy === 'snapshot' && status !== 'live') {
        dirtyDocIds.add(docId);
        return;
      }
      if (resyncStrategy === 'reconcile') {
        // Offline: the local store keeps the change; the next reconcile sends it.
        if (status !== 'live' || !socket || socket.readyState !== WS_OPEN) return;
      }
      if (tracksOwnAppends && status === 'live' && socket?.readyState === WS_OPEN) {
        const queue = pendingOwn.get(docId) ?? [];
        queue.push(bytes);
        pendingOwn.set(docId, queue);
      }
      send({ t: 'append', docId, payload: encodeBase64Url(bytes) });
    },
    sendSnapshot: (docId, bytes, covers) => {
      if (readOnly()) return;
      const live = status === 'live' && socket?.readyState === WS_OPEN;
      send({ t: 'snapshot', docId, payload: encodeBase64Url(bytes), covers });
      if (bytesMode && live) {
        // A save this session holds nothing of yet stays as it is, and one that adds nothing to the copy
        // it holds needs no merge: both are told by the heads in the save, so neither document is loaded
        // (a workspace or a page of a few megabytes takes seconds to load).
        const held = docs.get(docId);
        const savedHeads = hot?.docId === docId ? undefined : readSavedDocumentHeads(bytes);
        if (savedHeads && !held?.bytes && !held?.delta) {
          docs.set(docId, { kind: held?.kind ?? 'page', bytes, heads: savedHeads });
          unaccountedChanges.delete(docId);
          ownSnapshotDocIds.add(docId);
          return;
        }
        if (savedHeads && held?.heads && !unaccountedChanges.has(docId) && sameHeadSet(held.heads, savedHeads)) {
          ownSnapshotDocIds.add(docId);
          return;
        }
        try {
          const loaded = Automerge.load<unknown>(bytes);
          updateStoredDoc(docId, docs.get(docId)?.kind ?? 'page', (base) => {
            if (!base) return { doc: loaded, cleanBytes: bytes };
            const merged = Automerge.merge(base, loaded);
            freeRoomDoc(loaded);
            return { doc: merged };
          });
          ownSnapshotDocIds.add(docId);
        } catch {
          // Not a loadable save; the room copy stays as it was.
        }
      }
    },
    replaceDoc: (docId, bytes, covers) => {
      if (readOnly()) return;
      const heads = bytesMode ? readSavedDocumentHeads(bytes) : undefined;
      if (!heads) {
        api.sendSnapshot(docId, bytes, covers);
        return;
      }
      send({ t: 'snapshot', docId, payload: encodeBase64Url(bytes), covers });
      dropHotDoc(docId);
      unaccountedChanges.delete(docId);
      docs.set(docId, { kind: docs.get(docId)?.kind ?? 'workspace', bytes, heads });
      setSeq(docId, covers);
      ownSnapshotDocIds.add(docId);
    },
    getDocSeq: (docId) => since[docId],
    takeDocUpdates: (docId) => {
      const pending = pendingUpdates.get(docId);
      pendingUpdates.delete(docId);
      if (!pending) return { full: false };
      if (pending.full || pending.chunks.length === 0) return { full: true };
      return { full: false, changes: pending.chunks.length === 1 ? pending.chunks[0] : pending.chunks.reduce(concatBytes) };
    },
    announceDoc: (docId, kind) => {
      if (readOnly()) return;
      send({ t: 'announce', docId, kind });
      // Owner mode: the room knows the doc from now on (a lost announce is
      // corrected by the next welcome, which does not list it).
      if (bytesMode && !docs.has(docId)) docs.set(docId, { kind });
    },
    removeDoc: (docId) => {
      if (readOnly()) return;
      send({ t: 'remove', docId });
      if (bytesMode) {
        // The room does not echo the removal; forget the doc here too, so it
        // is announced again should it come back.
        dropHotDoc(docId);
        ownSnapshotDocIds.delete(docId);
        docs.delete(docId);
        delete since[docId];
      }
    },
    subscribeDocsChanged: (listener) => {
      docsChangedListeners.add(listener);
      return () => docsChangedListeners.delete(listener);
    },
    subscribeAcked: (listener) => {
      ackedListeners.add(listener);
      return () => ackedListeners.delete(listener);
    },
    sendReauth: (jwt) => {
      send({ t: 'reauth', jwt });
    },
    subscribeReauthed: (listener) => {
      reauthedListeners.add(listener);
      return () => reauthedListeners.delete(listener);
    },
    subscribeSynced: (listener) => {
      syncedListeners.add(listener);
      return () => { syncedListeners.delete(listener); };
    },
    getConfirmedHeads: (docId) => {
      const entry = docs.get(docId);
      if (bytesMode) return currentHeads(docId);
      return entry?.doc ? Automerge.getHeads(entry.doc) : undefined;
    },
    sendPresence: (state) => {
      if (!presenceSupported || !synced || !socket || socket.readyState !== WS_OPEN) return false;
      socket.send(JSON.stringify({ t: 'presence', state }));
      presenceSent = true;
      return true;
    },
    subscribePresence: (listener) => {
      presenceListeners.add(listener);
      return () => presenceListeners.delete(listener);
    },
    close: () => {
      disposed = true;
      networkEvents?.removeEventListener('online', onOnline);
      stopHeartbeat();
      if (reconnectTimer !== undefined) {
        clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
      socket?.close();
      settleHotDoc();
      setStatus('closed');
    },
  };
  return api;
}

export interface AckCompactionOptions {
  /** Snapshot after this many acked appends for a doc since its last compaction. Default 64 (PROTOCOL.md). */
  everyAckedAppends?: number;
}

/**
 * B1c real compaction: subscribes to acked `append`s and, every
 * `everyAckedAppends` (default 64) acks for a given doc, sends a `snapshot`
 * with `covers` set to the acked seq and payload from `getFullSnapshotBytes`.
 *
 * This is sound because the Durable Object processes frames serially and
 * delivers broadcasts in order: by the time an ack for seq N arrives at the
 * sender, every change with seq < N that this session produced has already
 * been merged into whatever `getFullSnapshotBytes` reads from (the sender is
 * the only writer of its own local doc state at that instant).
 *
 * Returns an unsubscribe function.
 */
export function attachAckCompaction(
  session: Pick<RoomSession, 'subscribeAcked' | 'sendSnapshot'>,
  getFullSnapshotBytes: (docId: string) => MaybePromise<Uint8Array | undefined>,
  options: AckCompactionOptions = {},
): () => void {
  const every = options.everyAckedAppends ?? 64;
  const countsSinceCompaction = new Map<string, number>();

  return session.subscribeAcked((docId, seq) => {
    const next = (countsSinceCompaction.get(docId) ?? 0) + 1;
    if (next < every) {
      countsSinceCompaction.set(docId, next);
      return;
    }
    countsSinceCompaction.set(docId, 0);
    const result = getFullSnapshotBytes(docId);
    // A snapshot read after the ack can only contain more than seq covers,
    // never less, so an asynchronous read (an unloaded page) stays sound.
    if (!isPromiseLike(result)) {
      if (result) session.sendSnapshot(docId, result, seq);
      return;
    }
    result.then(
      (bytes) => { if (bytes) session.sendSnapshot(docId, bytes, seq); },
      () => undefined,
    );
  });
}
