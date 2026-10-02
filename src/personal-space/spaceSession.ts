/**
 * Wraps `openRoomSession` (src/collab/session.ts) for the personal room:
 * the reauth timer, visibility/online triggers, the `SpaceStatus` machine,
 * and the `PersonalSpaceSession` facade so no UI file needs to import
 * `src/collab/` directly (PERSONAL-SYNC.md §5.3).
 */

import type * as Automerge from '@automerge/automerge';
import {
  SPACE_REAUTH_MARGIN_S,
  SPACE_WORKSPACE_DOC_ID,
  type SpaceStatus,
} from './contract';
import type { DocKind, Role } from '../collab/protocol';
import {
  openRoomSession,
  type RoomDocEntry,
  type RoomResume,
  type RoomSession,
  type RoomSessionMemoryDiagnostics,
  type WebSocketFactory,
} from '../collab/session';

/** A Clerk session token plus the `exp` claim it already carries, so the reauth timer never has to decode the JWT itself. */
export interface SpaceCredential {
  jwt: string;
  /** Unix seconds, the JWT's `exp` claim. */
  expiresAt: number;
}

/** Minimal surface of `EventTarget` the reauth triggers need; `document`/`window` satisfy this. */
export interface EventTargetLike {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

function defaultDocumentTarget(): (EventTargetLike & { visibilityState?: string }) | undefined {
  return typeof document === 'undefined' ? undefined : (document as unknown as EventTargetLike & { visibilityState?: string });
}

function defaultWindowTarget(): EventTargetLike | undefined {
  return typeof window === 'undefined' ? undefined : (window as unknown as EventTargetLike);
}

export interface AttachReauthTimerOptions {
  /** Resolves a fresh credential; called for the scheduled timer fire and for every visibility/online trigger. */
  getAuth(): Promise<SpaceCredential>;
  /** The `expiresAt` already in force when the timer is attached (from the credential the socket connected with). */
  initialExpiresAt: number;
  /** Seconds of margin before expiry to reauth; default `SPACE_REAUTH_MARGIN_S`. */
  marginS?: number;
  /** Floor on the scheduled delay, in seconds; default 5 (PERSONAL-SYNC.md §5.3). */
  minDelayS?: number;
  /** Injectable clock, in Unix seconds; default `Date.now() / 1000`. */
  nowS?(): number;
  /** Reports a `getAuth()` rejection instead of throwing into a timer callback. */
  onError?(error: unknown): void;
  /** `document`, for the `visibilitychange -> visible` trigger. Pass `null` to disable (e.g. in a non-DOM host). Defaults to the global `document` when present. */
  visibilityTarget?: (EventTargetLike & { visibilityState?: string }) | null;
  /** `window`, for the `online` trigger. Pass `null` to disable. Defaults to the global `window` when present. */
  onlineTarget?: EventTargetLike | null;
}

/**
 * Schedules `session.sendReauth` at `expiresAt - now - marginS` (floor
 * `minDelayS`), reschedules on every `reauthed` ack, and reauths immediately
 * on `visibilitychange -> visible` / `online` (PERSONAL-SYNC.md §2.6, §5.3).
 * Returns an unsubscribe function that clears the timer and detaches the
 * DOM listeners.
 */
export function attachReauthTimer(session: RoomSession, options: AttachReauthTimerOptions): () => void {
  const marginS = options.marginS ?? SPACE_REAUTH_MARGIN_S;
  const minDelayS = options.minDelayS ?? 5;
  const nowS = options.nowS ?? (() => Date.now() / 1000);
  const visibilityTarget = options.visibilityTarget !== undefined ? options.visibilityTarget : defaultDocumentTarget();
  const onlineTarget = options.onlineTarget !== undefined ? options.onlineTarget : defaultWindowTarget();

  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const reauthNow = (): void => {
    options.getAuth().then(
      (credential) => {
        if (disposed) return;
        session.sendReauth(credential.jwt);
      },
      (error: unknown) => {
        if (disposed) return;
        options.onError?.(error);
      },
    );
  };

  const schedule = (expiresAt: number): void => {
    clearTimer();
    if (disposed) return;
    const delayS = Math.max(minDelayS, expiresAt - nowS() - marginS);
    timer = setTimeout(() => {
      timer = undefined;
      reauthNow();
    }, delayS * 1000);
  };

  schedule(options.initialExpiresAt);

  const unsubscribeReauthed = session.subscribeReauthed((expiresAt) => schedule(expiresAt));

  const onVisibilityChange = (): void => {
    if (visibilityTarget?.visibilityState === 'visible') reauthNow();
  };
  const onOnline = (): void => reauthNow();

  visibilityTarget?.addEventListener('visibilitychange', onVisibilityChange);
  onlineTarget?.addEventListener('online', onOnline);

  return () => {
    disposed = true;
    clearTimer();
    unsubscribeReauthed();
    visibilityTarget?.removeEventListener('visibilitychange', onVisibilityChange);
    onlineTarget?.removeEventListener('online', onOnline);
  };
}

/** Inputs `deriveSpaceStatus` needs to compute the next `SpaceStatus`; pure and total. */
export interface SpaceStatusInput {
  connectionStatus: 'connecting' | 'syncing' | 'live' | 'closed' | 'error';
  /** The most recent non-fatal `onError`, if any has been seen since the last status recompute. */
  lastError?: { code: string; detail?: string };
  pendingDocs: number;
  nowIso: string;
}

/**
 * Maps `ConnectionStatus` plus quota/auth errors onto `SpaceStatus`
 * (PERSONAL-SYNC.md §5.3). Pure and total: the same input always produces
 * the same status. `disabled`/`signed-out`/`link-required`/`bootstrapping`
 * are not reachable from here — they are decided above this module, before
 * a session is even opened (§5.8), so a live session's status is always one
 * of the remaining five variants.
 */
export function deriveSpaceStatus(input: SpaceStatusInput): SpaceStatus {
  if (input.lastError?.code === 'quota-exceeded') {
    return { kind: 'quota-exceeded', scope: input.lastError.detail?.includes('asset') ? 'assets' : 'log' };
  }
  if (input.lastError?.code === 'unauthorized') {
    return { kind: 'error', message: input.lastError.detail ?? 'Reauthentication required.' };
  }
  switch (input.connectionStatus) {
    case 'live':
      return { kind: 'synced', lastSyncedAt: input.nowIso };
    case 'connecting':
    case 'syncing':
      return input.pendingDocs > 0
        ? { kind: 'offline', pendingDocs: input.pendingDocs }
        : { kind: 'reconnecting' };
    case 'closed':
    case 'error':
      return { kind: 'error', message: 'The personal space connection closed.' };
    default: {
      const exhaustive: never = input.connectionStatus;
      return exhaustive;
    }
  }
}

/**
 * Tells "this device has no network" apart from "the server is briefly out of
 * reach while the device is online". The socket cannot make that distinction
 * (a dropped connection looks the same in both cases), so the device's own
 * network state decides: with no network, every state that is waiting for or
 * claiming a connection reads as `offline`. Quota, sign-in and link decisions
 * stay as they are; they are not about the network.
 */
export function applyDeviceNetwork(status: SpaceStatus, online: boolean): SpaceStatus {
  if (online) return status;
  switch (status.kind) {
    case 'synced':
    case 'reconnecting':
    case 'bootstrapping':
      return { kind: 'offline', pendingDocs: 0 };
    case 'error':
      return /reauth|unauthori[sz]ed|signed out/i.test(status.message) ? status : { kind: 'offline', pendingDocs: 0 };
    default:
      return status;
  }
}

export interface OpenPersonalSpaceSessionOptions {
  /** Worker origin, e.g. `https://canvink-sync.example.com`. */
  syncUrl: string;
  spaceId: string;
  /** Resolves a fresh Clerk session token with its `exp`; called on every connect attempt (`getAuth`) and every reauth trigger. */
  getAuth(): Promise<SpaceCredential>;
  /** Full Automerge save for a docId; required for the P7 snapshot-resync path. May read an unloaded page asynchronously. */
  getFullSnapshotBytes(docId: string): Uint8Array | undefined | Promise<Uint8Array | undefined>;
  since?: Record<string, number>;
  /** Documents this device already holds from an earlier visit; the room only sends what came after. */
  resume?: RoomResume;
  /** Leave page documents out of the catch-up; `fetchDocs` requests them later (see `openRoomSession`). */
  lazyPages?: boolean;
  webSocketFactory?: WebSocketFactory;
  onStatus(status: SpaceStatus): void;
  onDocsChanged?(docId: string): void;
  onRole?(role: Role): void;
  reauthMarginS?: number;
  nowS?(): number;
  visibilityTarget?: (EventTargetLike & { visibilityState?: string }) | null;
  onlineTarget?: EventTargetLike | null;
}

export interface PersonalSpaceSession {
  getStatus(): SpaceStatus;
  /** Whether the socket is live (caught up and sending directly). */
  isLive(): boolean;
  /** Full Automerge save of the room's copy of a doc. */
  getDocBytes(docId: string): Uint8Array | undefined;
  /** Heads of the room's copy of a doc, when it has content. */
  getConfirmedHeads(docId: string): Automerge.Heads | undefined;
  getDocs(): ReadonlyMap<string, RoomDocEntry>;
  /** Requests documents the session holds nothing of yet; resolves once the room sent them (`lazyPages`). */
  fetchDocs(docIds: readonly string[]): Promise<void>;
  /** Whether the session holds content of a room document. */
  holdsDoc(docId: string): boolean;
  /** The room has the document but nothing of it was requested or received yet (`lazyPages`). */
  awaitsFetch(docId: string): boolean;
  sendLocalChange(docId: string, bytes: Uint8Array): void;
  sendSnapshot(docId: string, bytes: Uint8Array, covers: number): void;
  /** Replaces the room's copy of a document with one that has none of its history (see `RoomSession.replaceDoc`). */
  replaceDoc(docId: string, bytes: Uint8Array, covers: number): void;
  /** The newest room sequence number applied for a document. */
  getDocSeq(docId: string): number | undefined;
  /** What reached this session for a workspace document since the last call (see `RoomSession.takeDocUpdates`). */
  takeDocUpdates(docId: string): { full: boolean; changes?: Uint8Array };
  announceDoc(docId: string, kind: DocKind): void;
  removeDoc(docId: string): void;
  subscribeDocsChanged(listener: (docId: string) => void): () => void;
  /** Fires once per acknowledged append of this session, with the room's sequence number. */
  subscribeAcked(listener: (docId: string, seq: number) => void): () => void;
  /** Fires after each catch-up completed (`synced`). */
  subscribeSynced(listener: () => void): () => void;
  getMemoryDiagnostics(): RoomSessionMemoryDiagnostics;
  /** Documents whose room state is known, to resume from on the next visit. */
  getResumeState(): RoomResume;
  close(): void;
}

/**
 * Opens the personal room (`roomId = spaceId`) with `{ kind: 'personal',
 * jwt }` auth, the P7 snapshot-resync strategy, the reauth timer, and the
 * `SpaceStatus` machine. This is the only façade `src/personal-space/`
 * exposes over `src/collab/session.ts` (PERSONAL-SYNC.md §5.3, §6.7).
 */
export function openPersonalSpaceSession(options: OpenPersonalSpaceSessionOptions): PersonalSpaceSession {
  let latestStatus: SpaceStatus = { kind: 'reconnecting' };
  let lastError: { code: string; detail?: string } | undefined;
  const pendingDocIds = new Set<string>();
  let detachReauthTimer: (() => void) | undefined;

  const nowIso = (): string => new Date().toISOString();

  const recompute = (connectionStatus: SpaceStatusInput['connectionStatus']): void => {
    latestStatus = deriveSpaceStatus({
      connectionStatus,
      lastError,
      pendingDocs: pendingDocIds.size,
      nowIso: nowIso(),
    });
    options.onStatus(latestStatus);
  };

  const session: RoomSession = openRoomSession({
    syncUrl: options.syncUrl,
    roomId: options.spaceId,
    auth: { kind: 'personal', jwt: '' }, // placeholder; getAuth below supplies the real credential on every attempt.
    since: options.since,
    resume: options.resume,
    lazyPages: options.lazyPages,
    webSocketFactory: options.webSocketFactory,
    resyncStrategy: 'snapshot',
    // The local workspace is the real copy of every document; the session
    // keeps the room's copies as compact bytes instead of live documents.
    docStorage: 'bytes',
    getFullSnapshotBytes: options.getFullSnapshotBytes,
    getAuth: async () => {
      const credential = await options.getAuth();
      // Reattach on every resolved credential (initial connect and every
      // reconnect), so the timer always schedules off the freshest
      // `expiresAt` rather than the one captured at construction.
      detachReauthTimer?.();
      detachReauthTimer = attachReauthTimer(session, {
        getAuth: options.getAuth,
        initialExpiresAt: credential.expiresAt,
        marginS: options.reauthMarginS,
        nowS: options.nowS,
        visibilityTarget: options.visibilityTarget,
        onlineTarget: options.onlineTarget,
        onError: (error) => {
          lastError = { code: 'bad-frame', detail: error instanceof Error ? error.message : String(error) };
          recompute(session.getStatus());
        },
      });
      return { kind: 'personal', jwt: credential.jwt };
    },
    callbacks: {
      onStatus: (status) => {
        if (status === 'live') pendingDocIds.clear();
        recompute(status);
      },
      onDocsChanged: options.onDocsChanged,
      onRole: options.onRole,
      onError: (error) => {
        lastError = { code: error.code, detail: error.detail };
        recompute(session.getStatus());
      },
    },
  });

  return {
    getStatus: () => latestStatus,
    isLive: () => session.getStatus() === 'live',
    getDocBytes: (docId) => session.getDocBytes(docId),
    getConfirmedHeads: (docId) => session.getConfirmedHeads(docId),
    getDocs: () => session.getDocs(),
    fetchDocs: (docIds) => session.fetchDocs(docIds),
    holdsDoc: (docId) => session.holdsDoc(docId),
    awaitsFetch: (docId) => session.awaitsFetch(docId),
    sendLocalChange: (docId, bytes) => {
      if (session.getStatus() !== 'live') pendingDocIds.add(docId);
      session.sendLocalChange(docId, bytes);
    },
    sendSnapshot: (docId, bytes, covers) => session.sendSnapshot(docId, bytes, covers),
    replaceDoc: (docId, bytes, covers) => session.replaceDoc(docId, bytes, covers),
    getDocSeq: (docId) => session.getDocSeq(docId),
    takeDocUpdates: (docId) => session.takeDocUpdates(docId),
    announceDoc: (docId, kind) => session.announceDoc(docId, kind),
    removeDoc: (docId) => session.removeDoc(docId),
    subscribeDocsChanged: (listener) => session.subscribeDocsChanged(listener),
    subscribeAcked: (listener) => session.subscribeAcked(listener),
    subscribeSynced: (listener) => session.subscribeSynced(listener),
    getMemoryDiagnostics: () => session.getMemoryDiagnostics(),
    getResumeState: () => session.getResumeState(),
    close: () => {
      detachReauthTimer?.();
      session.close();
    },
  };
}

/** Re-exported so callers of this module never need `SPACE_WORKSPACE_DOC_ID` from `./contract` directly for the common case of checking whether a docId is the workspace doc. */
export function isWorkspaceDocId(docId: string): boolean {
  return docId === SPACE_WORKSPACE_DOC_ID;
}
