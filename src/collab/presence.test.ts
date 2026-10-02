import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PRESENCE_HEARTBEAT_MS,
  PRESENCE_IDLE_MS,
  PRESENCE_PEER_TIMEOUT_MS,
  PresenceHub,
  distinctPeople,
  isPeerIdle,
  jumpTarget,
  parsePresenceState,
  presenceColorFor,
  presenceInitials,
  safeAvatarUrl,
  type PresencePeer,
  type PresenceTransport,
  type PresenceWireState,
} from './presence';
import type { PresenceEvent } from './session';

class FakeTransport implements PresenceTransport {
  connected = true;
  sent: PresenceWireState[] = [];
  private listener: ((event: PresenceEvent) => void) | undefined;
  sendPresence(state: Record<string, unknown>): boolean {
    if (!this.connected) return false;
    this.sent.push(structuredClone(state) as unknown as PresenceWireState);
    return true;
  }
  subscribePresence(listener: (event: PresenceEvent) => void): () => void {
    this.listener = listener;
    return () => { this.listener = undefined; };
  }
  emit(event: PresenceEvent): void {
    this.listener?.(event);
  }
  last(): PresenceWireState {
    const state = this.sent.at(-1);
    if (!state) throw new Error('nothing sent');
    return state;
  }
}

const ANNA = { id: 'u-anna', name: 'Anna Muster', color: '#1971c2' };

function peerState(overrides: Partial<PresenceWireState> = {}): PresenceWireState {
  return {
    v: 1,
    user: { id: 'u-ben', name: 'Ben', color: '#c2255c' },
    page: 'page-1',
    away: false,
    cursor: [10, 20],
    focus: null,
    view: null,
    ink: null,
    ...overrides,
  };
}

describe('parsePresenceState', () => {
  it('accepts a well-formed state and keeps only Clerk-hosted avatars', () => {
    const parsed = parsePresenceState({
      ...peerState(),
      user: { id: 'u-ben', name: 'Ben', color: '#c2255c', img: 'https://img.clerk.com/abc' },
    });
    expect(parsed?.user.img).toBe('https://img.clerk.com/abc');
    const tracker = parsePresenceState({
      ...peerState(),
      user: { id: 'u-ben', name: 'Ben', color: '#c2255c', img: 'https://tracker.example/pixel.png' },
    });
    expect(tracker?.user.img).toBeUndefined();
  });

  it('rejects states without identity or with another version, and drops malformed parts', () => {
    expect(parsePresenceState({ ...peerState(), v: 2 })).toBeNull();
    expect(parsePresenceState({ ...peerState(), user: { id: '', name: 'x', color: '#000000' } })).toBeNull();
    const parsed = parsePresenceState({
      ...peerState(),
      user: { id: 'u', name: 'Eve\u0007', color: 'red' },
      cursor: [Number.NaN, 1],
      focus: [0, 0, -5, 3],
      ink: { id: 's1', from: 0, pts: [1, 2, 3], tool: 'pen', color: '#000000', size: 2, opacity: 1 },
    });
    expect(parsed).toMatchObject({ cursor: null, focus: null, ink: null });
    expect(parsed?.user.name).toBe('Eve');
    expect(parsed?.user.color).toBe(presenceColorFor('u'));
  });
});

describe('identity helpers', () => {
  it('derives initials and a stable palette colour', () => {
    expect(presenceInitials('Anna Muster')).toBe('AM');
    expect(presenceInitials('Windows-Gerät')).toBe('WG');
    expect(presenceInitials('ben')).toBe('BE');
    expect(presenceColorFor('u-anna')).toBe(presenceColorFor('u-anna'));
    expect(safeAvatarUrl('http://img.clerk.com/x')).toBeUndefined();
  });

  it('collapses several connections of one person, preferring the present one', () => {
    const base = { role: 'editor', page: null, cursor: null, focus: null, view: null, focusAt: 0, ink: null, seenAt: 0 } as const;
    const peers: PresencePeer[] = [
      { ...base, connId: 'a', user: ANNA, away: true, activeAt: 5 },
      { ...base, connId: 'b', user: ANNA, away: false, activeAt: 1 },
      { ...base, connId: 'c', user: { id: 'u-ben', name: 'Ben', color: '#c2255c' }, away: false, activeAt: 3 },
    ];
    expect(distinctPeople(peers).map((peer) => peer.connId)).toEqual(['b', 'c']);
  });
});

describe('PresenceHub publishing', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('throttles pointer moves to one frame per interval with the latest position', () => {
    const transport = new FakeTransport();
    const hub = new PresenceHub(transport, { user: ANNA });
    vi.advanceTimersByTime(50);
    transport.sent = [];
    hub.setPage('page-1');
    for (let x = 0; x < 20; x += 1) hub.setCursor({ x, y: 5 });
    vi.advanceTimersByTime(45);
    expect(transport.sent).toHaveLength(1);
    expect(transport.last()).toMatchObject({ page: 'page-1', cursor: [19, 5] });
    hub.dispose();
  });

  it('sends in-progress ink as ordered point deltas and the final chunk with done at once', () => {
    const transport = new FakeTransport();
    const hub = new PresenceHub(transport, { user: ANNA });
    hub.setPage('page-1');
    vi.advanceTimersByTime(50);
    transport.sent = [];
    const style = { tool: 'pen' as const, color: '#111111', size: 2, opacity: 1 };
    const stroke = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
    hub.inkProgress(style, stroke);
    vi.advanceTimersByTime(45);
    stroke.push({ x: 2, y: 2 }, { x: 3, y: 3 });
    hub.inkProgress(style, stroke);
    vi.advanceTimersByTime(45);
    stroke.push({ x: 4, y: 4 });
    hub.inkProgress(style, stroke);
    hub.inkEnd();
    const inkFrames = transport.sent.map((state) => state.ink).filter(Boolean);
    expect(inkFrames.map((ink) => [ink!.from, ink!.pts.length / 2, ink!.done ?? false])).toEqual([
      [0, 2, false],
      [2, 2, false],
      [4, 1, true],
    ]);
    // The work region now covers the stroke.
    expect(transport.last().focus).not.toBeNull();
    vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS);
    expect(transport.last().ink).toBeNull();
    hub.dispose();
  });

  it('resends its state and the whole current stroke after a reconnect', () => {
    const transport = new FakeTransport();
    const hub = new PresenceHub(transport, { user: ANNA });
    hub.setPage('page-1');
    const style = { tool: 'pen' as const, color: '#111111', size: 2, opacity: 1 };
    hub.inkProgress(style, [{ x: 0, y: 0 }, { x: 1, y: 1 }]);
    vi.advanceTimersByTime(50);
    transport.emit({ kind: 'live' });
    expect(transport.last().ink).toMatchObject({ from: 0, pts: [0, 0, 1, 1] });
    hub.dispose();
  });

  it('clears pointer and ink when the tab is hidden or the page changes', () => {
    const transport = new FakeTransport();
    const hub = new PresenceHub(transport, { user: ANNA });
    hub.setPage('page-1');
    hub.setCursor({ x: 4, y: 4 });
    vi.advanceTimersByTime(50);
    hub.setAway(true);
    vi.advanceTimersByTime(50);
    expect(transport.last()).toMatchObject({ away: true, cursor: null });
    hub.setAway(false);
    hub.setCursor({ x: 1, y: 1 });
    hub.setPage('page-2');
    vi.advanceTimersByTime(50);
    expect(transport.last()).toMatchObject({ page: 'page-2', cursor: null, away: false });
    hub.dispose();
  });
});

describe('PresenceHub peers', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('assembles a peer stroke from deltas and forgets it after the pen is lifted', () => {
    const transport = new FakeTransport();
    const hub = new PresenceHub(transport, { user: ANNA });
    const ink = { id: 's1', tool: 'pen' as const, color: '#111111', size: 2, opacity: 1 };
    transport.emit({ kind: 'state', from: 'c1', role: 'editor', state: peerState({ ink: { ...ink, from: 0, pts: [0, 0, 1, 1] } }) });
    transport.emit({ kind: 'state', from: 'c1', role: 'editor', state: peerState({ ink: { ...ink, from: 2, pts: [2, 2] } }) });
    expect(hub.getPeers()[0].ink?.points).toEqual([{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }]);
    transport.emit({ kind: 'state', from: 'c1', role: 'editor', state: peerState({ ink: { ...ink, from: 3, pts: [3, 3], done: true } }) });
    expect(hub.getPeers()[0].ink?.doneAt).not.toBeNull();
    vi.advanceTimersByTime(3_000);
    expect(hub.getPeers()[0].ink).toBeNull();
    hub.dispose();
  });

  it('ignores ink claimed by a read-only viewer socket but still shows its pointer', () => {
    const transport = new FakeTransport();
    const hub = new PresenceHub(transport, { user: ANNA });
    transport.emit({
      kind: 'state', from: 'v1', role: 'viewer',
      state: peerState({ ink: { id: 's1', from: 0, pts: [0, 0], tool: 'pen', color: '#111111', size: 2, opacity: 1 } }),
    });
    expect(hub.getPeers()[0]).toMatchObject({ ink: null, cursor: { x: 10, y: 20 } });
    hub.dispose();
  });

  it('notifies roster listeners only for joins, leaves, page and away changes', () => {
    const transport = new FakeTransport();
    const hub = new PresenceHub(transport, { user: ANNA });
    const roster = vi.fn();
    const all = vi.fn();
    hub.subscribeRoster(roster);
    hub.subscribe(all);
    transport.emit({ kind: 'state', from: 'c1', role: 'editor', state: peerState() });
    transport.emit({ kind: 'state', from: 'c1', role: 'editor', state: peerState({ cursor: [11, 21] }) });
    transport.emit({ kind: 'state', from: 'c1', role: 'editor', state: peerState({ page: 'page-2' }) });
    expect(all).toHaveBeenCalledTimes(3);
    expect(roster).toHaveBeenCalledTimes(2);
    transport.emit({ kind: 'leave', from: 'c1' });
    expect(hub.getRoster()).toEqual([]);
    expect(roster).toHaveBeenCalledTimes(3);
    hub.dispose();
  });

  it('drops peers on disconnect and after the timeout when a tab vanished without leave', () => {
    const transport = new FakeTransport();
    const hub = new PresenceHub(transport, { user: ANNA });
    transport.emit({ kind: 'state', from: 'c1', role: 'editor', state: peerState() });
    transport.emit({ kind: 'reset' });
    expect(hub.getPeers()).toEqual([]);
    transport.emit({ kind: 'state', from: 'c2', role: 'editor', state: peerState() });
    vi.advanceTimersByTime(PRESENCE_PEER_TIMEOUT_MS + 1_500);
    expect(hub.getPeers()).toEqual([]);
    hub.dispose();
  });
});

describe('presence view, jump and follow', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('publishes the visible part of the page rounded and clears it on a page change', () => {
    const transport = new FakeTransport();
    const hub = new PresenceHub(transport, { user: ANNA });
    hub.setPage('page-1');
    hub.setView({ x: 10.4, y: 20.6, width: 800.2, height: 600 });
    vi.advanceTimersByTime(50);
    expect(transport.last()).toMatchObject({ view: [10, 21, 800, 600] });
    hub.setPage('page-2');
    vi.advanceTimersByTime(50);
    expect(transport.last()).toMatchObject({ view: null });
    hub.dispose();
  });

  it('rejects an empty or non-finite view and keeps a valid one', () => {
    expect(parsePresenceState(peerState({ view: [0, 0, 0, 100] }))?.view).toBeNull();
    expect(parsePresenceState({ ...peerState(), view: [0, 0, Infinity, 1] })?.view).toBeNull();
    expect(parsePresenceState(peerState({ view: [5, 6, 700, 500] }))?.view).toEqual([5, 6, 700, 500]);
    expect(parsePresenceState({ ...peerState(), view: undefined })?.view).toBeNull();
  });

  it('jumps to their window, or around their pointer for a client that sends none', () => {
    expect(jumpTarget({ view: { x: 1, y: 2, width: 3, height: 4 }, cursor: null, focus: null })).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    expect(jumpTarget({ view: null, cursor: { x: 500, y: 400 }, focus: null })).toMatchObject({ x: 20, y: 80, width: 960, height: 640 });
    expect(jumpTarget({ view: null, cursor: null, focus: null })).toBeNull();
  });

  it('counts a change of their window as activity and dims after the idle time', () => {
    const transport = new FakeTransport();
    const hub = new PresenceHub(transport, { user: ANNA });
    transport.emit({ kind: 'state', from: 'c1', role: 'editor', state: peerState({ view: [0, 0, 800, 600] }) });
    const first = hub.getPeers()[0];
    expect(isPeerIdle(first, first.activeAt + PRESENCE_IDLE_MS - 1)).toBe(false);
    expect(isPeerIdle(first, first.activeAt + PRESENCE_IDLE_MS + 1)).toBe(true);
    vi.advanceTimersByTime(10_000);
    transport.emit({ kind: 'state', from: 'c1', role: 'editor', state: peerState({ view: [0, 0, 800, 600] }) });
    expect(hub.getPeers()[0].activeAt).toBe(first.activeAt);
    transport.emit({ kind: 'state', from: 'c1', role: 'editor', state: peerState({ view: [0, 300, 800, 600] }) });
    expect(hub.getPeers()[0].activeAt).toBeGreaterThan(first.activeAt);
    hub.dispose();
  });

  it('holds a reveal for a page that is still opening and delivers it once', () => {
    const transport = new FakeTransport();
    const hub = new PresenceHub(transport, { user: ANNA });
    const view = { x: 0, y: 0, width: 100, height: 100 };
    hub.requestReveal('page-2', view);
    const early = vi.fn();
    const other = hub.subscribeReveal('page-1', early);
    expect(early).not.toHaveBeenCalled();
    const late = vi.fn();
    hub.subscribeReveal('page-2', late);
    expect(late).toHaveBeenCalledWith(view);
    hub.requestReveal('page-2', { ...view, x: 5 });
    expect(late).toHaveBeenCalledTimes(2);
    other();
    hub.dispose();
  });

  it('drops a reveal that waited too long', () => {
    const transport = new FakeTransport();
    const hub = new PresenceHub(transport, { user: ANNA });
    hub.requestReveal('page-2', { x: 0, y: 0, width: 1, height: 1 });
    vi.advanceTimersByTime(20_000);
    const late = vi.fn();
    hub.subscribeReveal('page-2', late);
    expect(late).not.toHaveBeenCalled();
    hub.dispose();
  });

  it('ends following when the person leaves the room', () => {
    const transport = new FakeTransport();
    const hub = new PresenceHub(transport, { user: ANNA });
    transport.emit({ kind: 'state', from: 'c1', role: 'editor', state: peerState() });
    hub.follow('u-ben');
    expect(hub.getFollowing()).toBe('u-ben');
    expect(hub.getPerson('u-ben')?.connId).toBe('c1');
    transport.emit({ kind: 'leave', from: 'c1' });
    expect(hub.getFollowing()).toBeNull();
    hub.dispose();
  });
});
