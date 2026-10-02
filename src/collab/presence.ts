/**
 * Live presence for shared rooms: who is in the notebook, on which page,
 * where their pointer is, the stroke they are drawing right now and the
 * region they work in.
 *
 * Transport: the room's own WebSocket (`RoomSession.sendPresence`), relayed
 * by the collab-sync Worker without being stored (PROTOCOL.md "Presence").
 * This is the room-channel equivalent of Yjs awareness or automerge-repo's
 * ephemeral messages; shared rooms do not run an automerge-repo network
 * adapter, so `DocHandle.broadcast` would never leave the device.
 *
 * Everything received here is untrusted peer input and goes through
 * `parsePresenceState` before it reaches the UI.
 */

import { featureOverrideAllowed } from '../config/featureFlags';
import type { Role } from './protocol';
import type { PresenceEvent } from './session';

export const PRESENCE_VERSION = 1;

/** Minimum gap between two presence frames while something changes (~25 Hz). */
export const PRESENCE_SEND_INTERVAL_MS = 40;
/** Full-state resend while nothing changes, so late joiners and a hibernated relay recover. */
export const PRESENCE_HEARTBEAT_MS = 5_000;
/** A peer that sent nothing for this long is dropped (a crashed tab never sends `leave`). */
export const PRESENCE_PEER_TIMEOUT_MS = 16_000;
/** No pointer, ink or view movement for this long dims a person's face. */
export const PRESENCE_IDLE_MS = 3 * 60_000;
/** Strokes drawn within this window make up the local work region. */
export const PRESENCE_FOCUS_WINDOW_MS = 12_000;

/** A jump to a page that is still opening waits this long for its canvas. */
const REVEAL_WAIT_MS = 15_000;
const MAX_INK_POINTS_PER_FRAME = 400;
const MAX_INK_POINTS = 4_000;
const MAX_COORDINATE = 1_000_000;
const MAX_NAME_LENGTH = 60;
const MAX_ID_LENGTH = 64;
const FOCUS_PADDING = 24;

export interface PresencePoint { x: number; y: number }
export interface PresenceRect { x: number; y: number; width: number; height: number }

export interface PresenceUser {
  /** Stable, non-secret id used for colour and de-duplication. */
  id: string;
  name: string;
  /** `#rrggbb`, used for cursor, label, avatar ring and highlight. */
  color: string;
  /** Profile picture; only accepted from Clerk's image hosts (`safeAvatarUrl`). */
  imageUrl?: string;
}

export interface PresenceInkStyle {
  tool: 'pen' | 'highlighter';
  color: string;
  size: number;
  opacity: number;
}

/** The `state` object inside a `presence` frame (schema v1). */
export interface PresenceWireState {
  v: 1;
  user: { id: string; name: string; color: string; img?: string };
  /** Page document id the sender looks at, or null (for example the page list only). */
  page: string | null;
  /** The sender's tab is hidden. */
  away: boolean;
  cursor: [number, number] | null;
  focus: [number, number, number, number] | null;
  /** The part of the page the sender's window shows: `x, y, width, height` in page coordinates. */
  view?: [number, number, number, number] | null;
  ink: {
    id: string;
    /** Index of the first point in `pts` within the whole stroke. */
    from: number;
    /** Flat `x, y` pairs in page coordinates. */
    pts: number[];
    tool: 'pen' | 'highlighter';
    color: string;
    size: number;
    opacity: number;
    done?: true;
  } | null;
}

export interface PresencePeerInk {
  id: string;
  style: PresenceInkStyle;
  points: PresencePoint[];
  /** Set once the peer lifted the pen; the committed stroke arrives through the document. */
  doneAt: number | null;
}

export interface PresencePeer {
  connId: string;
  role: Role;
  user: PresenceUser;
  page: string | null;
  away: boolean;
  cursor: PresencePoint | null;
  focus: PresenceRect | null;
  /** What their window shows of `page`; the target of "jump to". */
  view: PresenceRect | null;
  /** When `focus` last changed; drives the fade-out of the highlight. */
  focusAt: number;
  ink: PresencePeerInk | null;
  /** Last frame of any kind. */
  seenAt: number;
  /** Last pointer, ink or focus change. */
  activeAt: number;
}

const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

/** Label colours with at least 4.8:1 contrast against white text. */
export const PRESENCE_COLORS = [
  '#c2255c', '#9c36b5', '#6741d9', '#1971c2',
  '#0b7285', '#2f7d32', '#b35900', '#c92a2a',
] as const;

/** FNV-1a, enough to spread ids over the palette and to hash a Clerk id before it leaves the device. */
export function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function presenceColorFor(id: string): string {
  return PRESENCE_COLORS[hashString(id) % PRESENCE_COLORS.length];
}

/** Up to two initials, for the avatar fallback. */
export function presenceInitials(name: string): string {
  const words = name.trim().split(/[\s._@-]+/u).filter(Boolean);
  const letters = words.length >= 2
    ? [words[0], words[words.length - 1]].map((word) => Array.from(word)[0] ?? '')
    : Array.from(words[0] ?? '?').slice(0, 2);
  return letters.join('').toLocaleUpperCase() || '?';
}

const AVATAR_HOSTS = new Set(['img.clerk.com', 'images.clerk.dev']);

/**
 * Only Clerk-hosted profile pictures are rendered. A peer could otherwise
 * send any URL and learn every viewer's IP address from the image request.
 */
export function safeAvatarUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && AVATAR_HOSTS.has(url.hostname) ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function finiteCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_COORDINATE;
}

function cleanText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  // Control characters would only ever be used to garble the label.
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength);
  return text.length > 0 ? text : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates and normalises a peer's presence state; `null` when it is not usable. */
export function parsePresenceState(raw: unknown): PresenceWireState | null {
  if (!isRecord(raw) || raw.v !== PRESENCE_VERSION || !isRecord(raw.user)) return null;
  const id = cleanText(raw.user.id, MAX_ID_LENGTH);
  const name = cleanText(raw.user.name, MAX_NAME_LENGTH);
  const color = typeof raw.user.color === 'string' && COLOR_PATTERN.test(raw.user.color)
    ? raw.user.color
    : undefined;
  if (!id || !name) return null;
  const img = safeAvatarUrl(raw.user.img);
  const page = raw.page === null || raw.page === undefined ? null : cleanText(raw.page, 200) ?? null;

  let cursor: PresenceWireState['cursor'] = null;
  if (Array.isArray(raw.cursor) && raw.cursor.length === 2 && raw.cursor.every(finiteCoordinate)) {
    cursor = [raw.cursor[0] as number, raw.cursor[1] as number];
  }
  let focus: PresenceWireState['focus'] = null;
  if (
    Array.isArray(raw.focus) && raw.focus.length === 4 && raw.focus.every(finiteCoordinate)
    && (raw.focus[2] as number) >= 0 && (raw.focus[3] as number) >= 0
  ) {
    focus = [raw.focus[0], raw.focus[1], raw.focus[2], raw.focus[3]] as [number, number, number, number];
  }

  let view: NonNullable<PresenceWireState['view']> | null = null;
  if (
    Array.isArray(raw.view) && raw.view.length === 4 && raw.view.every(finiteCoordinate)
    && (raw.view[2] as number) > 0 && (raw.view[3] as number) > 0
  ) {
    view = [raw.view[0], raw.view[1], raw.view[2], raw.view[3]] as [number, number, number, number];
  }

  let ink: PresenceWireState['ink'] = null;
  if (isRecord(raw.ink)) {
    const inkId = cleanText(raw.ink.id, MAX_ID_LENGTH);
    const pts = raw.ink.pts;
    const tool = raw.ink.tool === 'highlighter' ? 'highlighter' : raw.ink.tool === 'pen' ? 'pen' : undefined;
    const size = raw.ink.size;
    const opacity = raw.ink.opacity;
    const from = raw.ink.from;
    if (
      inkId && tool
      && Array.isArray(pts) && pts.length % 2 === 0 && pts.length <= MAX_INK_POINTS_PER_FRAME * 2
      && pts.every(finiteCoordinate)
      && typeof raw.ink.color === 'string' && COLOR_PATTERN.test(raw.ink.color)
      && typeof size === 'number' && size > 0 && size <= 200
      && typeof opacity === 'number' && opacity > 0 && opacity <= 1
      && typeof from === 'number' && Number.isInteger(from) && from >= 0 && from < MAX_INK_POINTS
    ) {
      ink = {
        id: inkId,
        from,
        pts: pts as number[],
        tool,
        color: raw.ink.color,
        size,
        opacity,
        ...(raw.ink.done === true ? { done: true as const } : {}),
      };
    }
  }

  return {
    v: 1,
    user: { id, name, color: color ?? presenceColorFor(id), ...(img ? { img } : {}) },
    page,
    away: raw.away === true,
    cursor,
    focus,
    view,
    ink,
  };
}

export function unionRect(left: PresenceRect | null, right: PresenceRect | null): PresenceRect | null {
  if (!left) return right;
  if (!right) return left;
  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  return {
    x,
    y,
    width: Math.max(left.x + left.width, right.x + right.width) - x,
    height: Math.max(left.y + left.height, right.y + right.height) - y,
  };
}

export function boundsOfPoints(points: readonly PresencePoint[], padding = 0): PresenceRect | null {
  if (points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { x: minX - padding, y: minY - padding, width: maxX - minX + padding * 2, height: maxY - minY + padding * 2 };
}

const round = (value: number): number => Math.round(value * 10) / 10;

/** What a hub needs from a room connection; `RoomSession` satisfies it. */
export interface PresenceTransport {
  sendPresence(state: Record<string, unknown>): boolean;
  subscribePresence(listener: (event: PresenceEvent) => void): () => void;
}

export interface PresenceHubOptions {
  user: PresenceUser;
  now?: () => number;
}

interface LocalInk {
  id: string;
  style: PresenceInkStyle;
  points: PresencePoint[];
  sent: number;
  done: boolean;
}

/**
 * One room's presence: publishes the local state (throttled, with ink sent
 * as batched point deltas) and keeps the peers' states for the UI.
 *
 * Two subscription levels keep React work proportional: `subscribe` fires
 * on every peer change (the canvas overlay), `subscribeRoster` only when
 * someone joins, leaves, changes page or goes away (avatars, page list).
 */
export class PresenceHub {
  private user: PresenceUser;
  private readonly now: () => number;
  private readonly transport: PresenceTransport;
  private page: string | null = null;
  private away = false;
  private cursor: PresencePoint | null = null;
  private selection: PresenceRect | null = null;
  private view: PresenceRect | null = null;
  private recentInk: Array<{ at: number; bounds: PresenceRect }> = [];
  private ink: LocalInk | null = null;
  private inkCounter = 0;
  private dirty = false;
  private lastSentAt = -Infinity;
  private sendTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private readonly peers = new Map<string, PresencePeer>();
  private peerList: readonly PresencePeer[] = [];
  private rosterList: readonly PresencePeer[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly rosterListeners = new Set<() => void>();
  private readonly unsubscribeTransport: () => void;
  private disposed = false;
  private following: string | null = null;
  private readonly followListeners = new Set<() => void>();
  private readonly revealListeners = new Map<string, (view: PresenceRect) => void>();
  private pendingReveal: { page: string; view: PresenceRect; at: number } | null = null;

  constructor(transport: PresenceTransport, options: PresenceHubOptions) {
    this.transport = transport;
    this.user = options.user;
    this.now = options.now ?? (() => Date.now());
    this.unsubscribeTransport = transport.subscribePresence((event) => this.receive(event));
    this.heartbeatTimer = setInterval(() => this.publishNow(), PRESENCE_HEARTBEAT_MS);
    this.sweepTimer = setInterval(() => this.sweep(), 1_000);
    this.markDirty();
  }

  // ---- local state -------------------------------------------------------

  setUser(user: PresenceUser): void {
    if (
      user.id === this.user.id && user.name === this.user.name
      && user.color === this.user.color && user.imageUrl === this.user.imageUrl
    ) return;
    this.user = user;
    this.markDirty();
  }

  getUser(): PresenceUser {
    return this.user;
  }

  /** The page (document id) this device shows. Switching pages clears pointer, ink and region. */
  setPage(page: string | null): void {
    if (page === this.page) return;
    this.page = page;
    this.cursor = null;
    this.selection = null;
    this.view = null;
    this.recentInk = [];
    this.ink = null;
    this.markDirty();
  }

  /** The visible part of the page, in page coordinates; null when no page is shown. */
  setView(view: PresenceRect | null): void {
    const next = view
      ? { x: Math.round(view.x), y: Math.round(view.y), width: Math.round(view.width), height: Math.round(view.height) }
      : null;
    if (sameRect(next, this.view)) return;
    this.view = next;
    this.markDirty();
  }

  setAway(away: boolean): void {
    if (away === this.away) return;
    this.away = away;
    if (away) {
      this.cursor = null;
      this.ink = null;
    }
    this.markDirty();
  }

  setCursor(point: PresencePoint | null): void {
    const next = point ? { x: round(point.x), y: round(point.y) } : null;
    if (next?.x === this.cursor?.x && next?.y === this.cursor?.y) return;
    this.cursor = next;
    this.markDirty();
  }

  /** Selected elements or the text being edited, in page coordinates. */
  setSelection(bounds: PresenceRect | null): void {
    this.selection = bounds;
    this.markDirty();
  }

  /** The complete in-progress stroke so far; only the new points go on the wire. */
  inkProgress(style: PresenceInkStyle, points: readonly PresencePoint[]): void {
    if (points.length === 0) return;
    if (!this.ink || this.ink.done) {
      this.inkCounter += 1;
      this.ink = { id: `s${this.inkCounter}`, style, points: [], sent: 0, done: false };
    }
    const ink = this.ink;
    const limit = Math.min(points.length, MAX_INK_POINTS);
    for (let index = ink.points.length; index < limit; index += 1) {
      ink.points.push({ x: round(points[index].x), y: round(points[index].y) });
    }
    const last = ink.points[ink.points.length - 1];
    if (last) this.cursor = last;
    this.markDirty();
  }

  /** The pen was lifted (or the stroke cancelled); the final points and `done` go out at once. */
  inkEnd(): void {
    const ink = this.ink;
    if (!ink || ink.done) return;
    ink.done = true;
    const bounds = boundsOfPoints(ink.points, ink.style.size / 2 + FOCUS_PADDING);
    if (bounds) this.recentInk.push({ at: this.now(), bounds });
    this.dirty = true;
    this.publishNow();
  }

  // ---- peers -------------------------------------------------------------

  // Arrow properties: stable references for `useSyncExternalStore`.
  readonly getPeers = (): readonly PresencePeer[] => this.peerList;

  /** Peers with only roster-relevant fields guaranteed fresh. */
  readonly getRoster = (): readonly PresencePeer[] => this.rosterList;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  readonly subscribeRoster = (listener: () => void): (() => void) => {
    this.rosterListeners.add(listener);
    return () => { this.rosterListeners.delete(listener); };
  };

  /** The freshest connection of a person (peer lists lag behind, this does not). */
  getPerson(userId: string): PresencePeer | undefined {
    return distinctPeople(this.peerList).find((peer) => peer.user.id === userId);
  }

  // ---- jump to and follow ------------------------------------------------

  /**
   * Asks the canvas of `page` to show `view`. The page may not be open yet
   * (a jump navigates first), so the request waits for its canvas to
   * subscribe and is dropped when that takes longer than `REVEAL_WAIT_MS`.
   */
  requestReveal(page: string, view: PresenceRect): void {
    const listener = this.revealListeners.get(page);
    if (listener) {
      this.pendingReveal = null;
      listener(view);
      return;
    }
    this.pendingReveal = { page, view, at: this.now() };
  }

  subscribeReveal(page: string, listener: (view: PresenceRect) => void): () => void {
    this.revealListeners.set(page, listener);
    const pending = this.pendingReveal;
    if (pending && pending.page === page) {
      this.pendingReveal = null;
      if (this.now() - pending.at <= REVEAL_WAIT_MS) listener(pending.view);
    }
    return () => {
      if (this.revealListeners.get(page) === listener) this.revealListeners.delete(page);
    };
  }

  /** The person whose window this device mirrors ("Folgen"), or null. */
  readonly getFollowing = (): string | null => this.following;

  readonly subscribeFollowing = (listener: () => void): (() => void) => {
    this.followListeners.add(listener);
    return () => { this.followListeners.delete(listener); };
  };

  follow(userId: string | null): void {
    if (userId === this.following) return;
    this.following = userId;
    for (const listener of this.followListeners) listener();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeTransport();
    if (this.sendTimer !== undefined) clearTimeout(this.sendTimer);
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    if (this.sweepTimer !== undefined) clearInterval(this.sweepTimer);
    this.peers.clear();
    this.emit(true);
  }

  // ---- internals -----------------------------------------------------------

  private focus(): PresenceRect | null {
    const cutoff = this.now() - PRESENCE_FOCUS_WINDOW_MS;
    this.recentInk = this.recentInk.filter((entry) => entry.at >= cutoff);
    let region = this.selection;
    for (const entry of this.recentInk) region = unionRect(region, entry.bounds);
    return region;
  }

  private wireState(): PresenceWireState {
    const ink = this.ink;
    let wireInk: PresenceWireState['ink'] = null;
    if (ink) {
      const chunk = ink.points.slice(ink.sent, ink.sent + MAX_INK_POINTS_PER_FRAME);
      wireInk = {
        id: ink.id,
        from: ink.sent,
        pts: chunk.flatMap((point) => [point.x, point.y]),
        tool: ink.style.tool,
        color: ink.style.color,
        size: ink.style.size,
        opacity: ink.style.opacity,
        ...(ink.done && ink.sent + chunk.length >= ink.points.length ? { done: true as const } : {}),
      };
    }
    const focus = this.focus();
    return {
      v: 1,
      user: {
        id: this.user.id,
        name: this.user.name,
        color: this.user.color,
        ...(this.user.imageUrl ? { img: this.user.imageUrl } : {}),
      },
      page: this.page,
      away: this.away,
      cursor: this.cursor ? [this.cursor.x, this.cursor.y] : null,
      focus: focus ? [round(focus.x), round(focus.y), round(focus.width), round(focus.height)] : null,
      view: this.view ? [this.view.x, this.view.y, this.view.width, this.view.height] : null,
      ink: wireInk,
    };
  }

  private markDirty(): void {
    if (this.disposed) return;
    this.dirty = true;
    if (this.sendTimer !== undefined) return;
    const wait = Math.max(0, this.lastSentAt + PRESENCE_SEND_INTERVAL_MS - this.now());
    this.sendTimer = setTimeout(() => {
      this.sendTimer = undefined;
      if (this.dirty) this.publishNow();
    }, wait);
  }

  /** Sends the current state now (heartbeat, pen lifted, reconnect). */
  private publishNow(): void {
    if (this.disposed) return;
    const state = this.wireState();
    const sent = this.transport.sendPresence(state as unknown as Record<string, unknown>);
    this.lastSentAt = this.now();
    this.dirty = false;
    const ink = this.ink;
    if (ink && sent && state.ink) {
      ink.sent = state.ink.from + state.ink.pts.length / 2;
      if (state.ink.done) this.ink = null;
      else if (ink.sent < ink.points.length) this.markDirty();
    } else if (ink?.done && !sent) {
      // Not connected: nobody is watching this stroke, so do not keep it for later.
      this.ink = null;
    }
  }

  private receive(event: PresenceEvent): void {
    if (this.disposed) return;
    switch (event.kind) {
      case 'live':
        // Resend everything, ink included from its first point.
        if (this.ink) this.ink.sent = 0;
        this.publishNow();
        return;
      case 'reset':
        if (this.peers.size === 0) return;
        this.peers.clear();
        this.emit(true);
        return;
      case 'leave':
        if (this.peers.delete(event.from)) this.emit(true);
        return;
      case 'state':
        this.applyPeerState(event.from, event.role, event.state);
        return;
    }
  }

  private applyPeerState(connId: string, role: Role, raw: unknown): void {
    const state = parsePresenceState(raw);
    if (!state) return;
    const at = this.now();
    const previous = this.peers.get(connId);
    const user: PresenceUser = {
      id: state.user.id,
      name: state.user.name,
      color: state.user.color,
      ...(state.user.img ? { imageUrl: state.user.img } : {}),
    };
    const cursor = state.cursor ? { x: state.cursor[0], y: state.cursor[1] } : null;
    const focus = state.focus
      ? { x: state.focus[0], y: state.focus[1], width: state.focus[2], height: state.focus[3] }
      : null;
    const view = state.view
      ? { x: state.view[0], y: state.view[1], width: state.view[2], height: state.view[3] }
      : null;
    const samePage = previous?.page === state.page;
    const viewChanged = !sameRect(previous?.view ?? null, view);
    const focusChanged = !sameRect(previous?.focus ?? null, focus);

    // Viewers cannot draw; ignore ink a read-only socket claims to be drawing.
    let ink: PresencePeerInk | null = samePage ? previous?.ink ?? null : null;
    if (role !== 'viewer' && state.ink) {
      const incoming = state.ink;
      const points: PresencePoint[] = [];
      for (let index = 0; index < incoming.pts.length; index += 2) {
        points.push({ x: incoming.pts[index], y: incoming.pts[index + 1] });
      }
      const style: PresenceInkStyle = {
        tool: incoming.tool, color: incoming.color, size: incoming.size, opacity: incoming.opacity,
      };
      if (ink && ink.id === incoming.id) {
        // Deltas arrive in order over one socket; a resend after reconnect starts at 0 again.
        const kept = ink.points.slice(0, Math.min(incoming.from, ink.points.length));
        ink = { id: ink.id, style, points: [...kept, ...points].slice(0, MAX_INK_POINTS), doneAt: incoming.done ? at : null };
      } else {
        ink = { id: incoming.id, style, points, doneAt: incoming.done ? at : null };
      }
    } else if (ink && ink.doneAt === null && !state.ink) {
      // The peer stopped drawing without a `done` (for example it went away).
      ink = { ...ink, doneAt: at };
    }

    const moved = !previous || previous.cursor?.x !== cursor?.x || previous.cursor?.y !== cursor?.y;
    const peer: PresencePeer = {
      connId,
      role,
      user,
      page: state.page,
      away: state.away,
      cursor: state.away ? null : cursor,
      focus,
      view,
      focusAt: focusChanged || !previous ? at : previous.focusAt,
      ink,
      seenAt: at,
      activeAt: moved || focusChanged || viewChanged || state.ink ? at : previous?.activeAt ?? at,
    };
    const rosterChanged = !previous
      || previous.page !== peer.page
      || previous.away !== peer.away
      || previous.user.id !== user.id
      || previous.user.name !== user.name
      || previous.user.color !== user.color
      || previous.user.imageUrl !== user.imageUrl
      || previous.role !== role;
    this.peers.set(connId, peer);
    this.emit(rosterChanged);
  }

  private sweep(): void {
    const at = this.now();
    let removed = false;
    let changed = false;
    for (const [connId, peer] of this.peers) {
      if (at - peer.seenAt > PRESENCE_PEER_TIMEOUT_MS) {
        this.peers.delete(connId);
        removed = true;
      } else if (peer.ink?.doneAt !== null && peer.ink && at - peer.ink.doneAt! > 1_500) {
        // The committed stroke has long arrived through the document.
        this.peers.set(connId, { ...peer, ink: null });
        changed = true;
      }
    }
    if (removed || changed) this.emit(removed);
  }

  private emit(roster: boolean): void {
    this.peerList = [...this.peers.values()];
    if (this.following && !this.peerList.some((peer) => peer.user.id === this.following)) this.follow(null);
    for (const listener of this.listeners) listener();
    if (!roster) return;
    this.rosterList = this.peerList;
    for (const listener of this.rosterListeners) listener();
  }
}

function sameRect(left: PresenceRect | null, right: PresenceRect | null): boolean {
  if (!left || !right) return left === right;
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}

/**
 * Collapses several connections of the same person (two tabs, phone and
 * laptop) into one entry, keeping the most recently active connection.
 */
export function distinctPeople(peers: readonly PresencePeer[]): PresencePeer[] {
  const byUser = new Map<string, PresencePeer>();
  for (const peer of peers) {
    const current = byUser.get(peer.user.id);
    if (!current || (current.away && !peer.away) || (current.away === peer.away && peer.activeAt > current.activeAt)) {
      byUser.set(peer.user.id, peer);
    }
  }
  return [...byUser.values()].sort((left, right) => (
    Number(left.away) - Number(right.away) || left.user.name.localeCompare(right.user.name)
  ));
}

/**
 * How long without movement counts as idle. The end-to-end build may shorten
 * it (`window.__canvinkPresenceIdleMs`), gated like the other test hooks, so
 * dimming can be tested without waiting minutes.
 */
export function presenceIdleAfterMs(): number {
  if (typeof window !== 'undefined' && featureOverrideAllowed(import.meta.env)) {
    const override = (window as Window & { __canvinkPresenceIdleMs?: unknown }).__canvinkPresenceIdleMs;
    if (typeof override === 'number' && override > 0) return override;
  }
  return PRESENCE_IDLE_MS;
}

export function isPeerIdle(peer: Pick<PresencePeer, 'activeAt'>, now: number): boolean {
  return now - peer.activeAt > presenceIdleAfterMs();
}

const FALLBACK_VIEW = { width: 960, height: 640 };

/**
 * What to show when jumping to a person: their window, otherwise a window
 * around their pointer or work region (an older client sends no view).
 */
export function jumpTarget(peer: Pick<PresencePeer, 'view' | 'cursor' | 'focus'>): PresenceRect | null {
  if (peer.view) return peer.view;
  const center = peer.cursor
    ?? (peer.focus ? { x: peer.focus.x + peer.focus.width / 2, y: peer.focus.y + peer.focus.height / 2 } : null);
  if (!center) return null;
  return {
    x: center.x - FALLBACK_VIEW.width / 2,
    y: center.y - FALLBACK_VIEW.height / 2,
    ...FALLBACK_VIEW,
  };
}

/** The point the preview centres on: pointer, then work region, then the middle of their window. */
export function previewCenter(peer: Pick<PresencePeer, 'view' | 'cursor' | 'focus'>): PresencePoint | null {
  if (peer.cursor) return peer.cursor;
  if (peer.focus) return { x: peer.focus.x + peer.focus.width / 2, y: peer.focus.y + peer.focus.height / 2 };
  if (peer.view) return { x: peer.view.x + peer.view.width / 2, y: peer.view.y + peer.view.height / 2 };
  return null;
}
