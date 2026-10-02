import * as Automerge from '@automerge/automerge';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeBase64Url } from './protocol';
import { attachAckCompaction, openRoomSession, type ConnectionStatus, type RoomSession } from './session';
import { createMockWebSocketFactory } from './testMocks';

function statusTracker(): { statuses: ConnectionStatus[]; onStatus: (s: ConnectionStatus) => void } {
  const statuses: ConnectionStatus[] = [];
  return { statuses, onStatus: (s) => statuses.push(s) };
}

describe('openRoomSession', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends hello immediately on open, then processes welcome/catch-up/synced in order', () => {
    const { factory, sockets } = createMockWebSocketFactory();
    const { statuses, onStatus } = statusTracker();
    const roles: string[] = [];
    const changed: string[] = [];

    const session = openRoomSession({
      syncUrl: 'https://sync.example.com',
      roomId: 'room1',
      auth: { kind: 'link', linkSecret: 'sec' },
      since: {},
      webSocketFactory: factory,
      callbacks: {
        onStatus,
        onRole: (role) => roles.push(role),
        onDocsChanged: (docId) => changed.push(docId),
      },
    });

    expect(sockets).toHaveLength(1);
    const ws = sockets[0];
    expect(ws.url).toBe('wss://sync.example.com/api/v1/rooms/room1/ws');
    ws.open();

    const hello = ws.sentFrames()[0];
    expect(hello).toEqual({ t: 'hello', auth: { kind: 'link', linkSecret: 'sec' }, since: {} });

    ws.receive({
      t: 'welcome',
      role: 'viewer',
      docs: [{ docId: 'notebook:1', kind: 'notebook' }],
      notebookTitle: 'Physics',
    });
    expect(statuses).toEqual(['connecting', 'syncing']);
    expect(roles).toEqual(['viewer']);

    const notebookDoc = Automerge.from({ kind: 'notebook', title: 'Physics', sections: [] });
    ws.receive({
      t: 'snapshot',
      docId: 'notebook:1',
      payload: encodeBase64Url(Automerge.save(notebookDoc)),
      covers: 0,
    });
    expect(changed).toEqual(['notebook:1']);
    expect(session.getDoc('notebook:1')).toBeDefined();

    ws.receive({ t: 'synced' });
    expect(statuses).toEqual(['connecting', 'syncing', 'live']);
    expect(session.getStatus()).toBe('live');

    session.close();
  });

  it('applies snapshot then append incrementally and removes docs', () => {
    const { factory, sockets } = createMockWebSocketFactory();
    const session = openRoomSession({
      syncUrl: 'https://sync.example.com',
      roomId: 'room1',
      auth: { kind: 'link', linkSecret: 'sec' },
      webSocketFactory: factory,
      callbacks: { onStatus: () => undefined },
    });
    const ws = sockets[0];
    ws.open();
    ws.receive({
      t: 'welcome',
      role: 'viewer',
      docs: [{ docId: 'page:1', kind: 'page' }],
      notebookTitle: 'Physics',
    });

    let pageDoc = Automerge.from({ kind: 'page', pageId: 'p1', title: 'Untitled' });
    ws.receive({
      t: 'snapshot',
      docId: 'page:1',
      payload: encodeBase64Url(Automerge.save(pageDoc)),
      covers: 0,
    });

    const before = pageDoc;
    pageDoc = Automerge.change(pageDoc, (draft) => {
      draft.title = 'Renamed';
    });
    const incremental = Automerge.getChanges(before, pageDoc).flatMap((change) => [...change]);
    ws.receive({
      t: 'append',
      docId: 'page:1',
      payload: encodeBase64Url(Uint8Array.from(incremental)),
      seq: 1,
    });

    const merged = session.getDoc('page:1') as { title: string } | undefined;
    expect(merged?.title).toBe('Renamed');

    ws.receive({ t: 'remove', docId: 'page:1' });
    expect(session.getDoc('page:1')).toBeUndefined();

    session.close();
  });

  it('queues local sends until synced, then flushes', () => {
    const { factory, sockets } = createMockWebSocketFactory();
    const session = openRoomSession({
      syncUrl: 'https://sync.example.com',
      roomId: 'room1',
      auth: { kind: 'owner', ownerToken: 'ot' },
      webSocketFactory: factory,
      callbacks: { onStatus: () => undefined },
    });
    const ws = sockets[0];
    ws.open();

    session.sendLocalChange('page:1', new Uint8Array([1, 2, 3]));
    expect(ws.sentFrames().some((frame) => frame.t === 'append')).toBe(false);

    ws.receive({ t: 'welcome', role: 'owner', docs: [], notebookTitle: 'Physics' });
    ws.receive({ t: 'synced' });

    const appendFrames = ws.sentFrames().filter((frame) => frame.t === 'append');
    expect(appendFrames).toHaveLength(1);
    expect(appendFrames[0].docId).toBe('page:1');

    session.close();
  });

  it('resumes with the correct since map after a reconnect', () => {
    const { factory, sockets } = createMockWebSocketFactory();
    const session = openRoomSession({
      syncUrl: 'https://sync.example.com',
      roomId: 'room1',
      auth: { kind: 'link', linkSecret: 'sec' },
      webSocketFactory: factory,
      random: () => 0,
      callbacks: { onStatus: () => undefined },
    });
    const first = sockets[0];
    first.open();
    first.receive({ t: 'welcome', role: 'viewer', docs: [{ docId: 'page:1', kind: 'page' }], notebookTitle: 'x' });
    const pageDoc = Automerge.from({ kind: 'page', pageId: 'p1', title: 't' });
    first.receive({
      t: 'snapshot',
      docId: 'page:1',
      payload: encodeBase64Url(Automerge.save(pageDoc)),
      covers: 5,
    });
    first.receive({ t: 'synced' });

    first.serverClose(1006);
    vi.advanceTimersByTime(2000);

    expect(sockets).toHaveLength(2);
    const second = sockets[1];
    second.open();
    const hello = second.sentFrames()[0];
    expect(hello.since).toEqual({ 'page:1': 5 });

    session.close();
  });

  it('reconnects with exponential backoff and jitter bounds', () => {
    const { factory, sockets } = createMockWebSocketFactory();
    const session: RoomSession = openRoomSession({
      syncUrl: 'https://sync.example.com',
      roomId: 'room1',
      auth: { kind: 'link', linkSecret: 'sec' },
      webSocketFactory: factory,
      random: () => 0,
      minBackoffMs: 1000,
      maxBackoffMs: 30000,
      callbacks: { onStatus: () => undefined },
    });

    sockets[0].serverClose(1006);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(999);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);

    sockets[1].serverClose(1006);
    vi.advanceTimersByTime(1999);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);

    session.close();
  });

  it('stops reconnecting after a fatal unauthorized error', () => {
    const { factory, sockets } = createMockWebSocketFactory();
    const errors: Array<{ code: string }> = [];
    const { statuses, onStatus } = statusTracker();
    openRoomSession({
      syncUrl: 'https://sync.example.com',
      roomId: 'room1',
      auth: { kind: 'link', linkSecret: 'bad' },
      webSocketFactory: factory,
      callbacks: { onStatus, onError: (error) => errors.push(error) },
    });
    const ws = sockets[0];
    ws.open();
    ws.receive({ t: 'error', code: 'unauthorized', detail: 'nope' });
    ws.serverClose(4401);

    expect(errors).toEqual([{ code: 'unauthorized', detail: 'nope' }]);
    expect(statuses.at(-1)).toBe('closed');

    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });

  it('B1b: merges an incoming snapshot into the doc already held, instead of replacing it', () => {
    const { factory, sockets } = createMockWebSocketFactory();
    const session = openRoomSession({
      syncUrl: 'https://sync.example.com',
      roomId: 'room1',
      auth: { kind: 'owner', ownerToken: 'ot' },
      webSocketFactory: factory,
      callbacks: { onStatus: () => undefined },
    });
    const ws = sockets[0];
    ws.open();
    ws.receive({ t: 'welcome', role: 'owner', docs: [{ docId: 'page:1', kind: 'page' }], notebookTitle: 'x' });

    // The client already holds a doc that has since progressed beyond the
    // first snapshot (as it would after any real `append` frame is applied
    // — see `applyAppend`, the only other way `session`'s doc map changes).
    const initial = Automerge.from<{ title: string; extra?: string }>({ title: 'first' });
    ws.receive({
      t: 'snapshot',
      docId: 'page:1',
      payload: encodeBase64Url(Automerge.save(initial)),
      covers: 0,
    });
    const advanced = Automerge.change(initial, (draft) => {
      draft.extra = 'change-after-first-snapshot';
    });
    const incremental = Automerge.getChanges(initial, advanced).flatMap((change) => [...change]);
    ws.receive({
      t: 'append',
      docId: 'page:1',
      payload: encodeBase64Url(Uint8Array.from(incremental)),
      seq: 1,
    });
    expect((session.getDoc('page:1') as { extra?: string }).extra).toBe('change-after-first-snapshot');

    // A second, unrelated snapshot arrives (e.g. a stale/redundant resend
    // from an independent lineage — the exact B1 shape: the server used to
    // *always* resend a doc's snapshot on catch-up). It must be merged in,
    // never replace the doc outright — otherwise the `extra` field set by
    // the append above would be silently discarded (B1's reconnect
    // data-loss failure mode).
    const otherDoc = Automerge.from({ title: 'from-elsewhere' });
    ws.receive({
      t: 'snapshot',
      docId: 'page:1',
      payload: encodeBase64Url(Automerge.save(otherDoc)),
      covers: 0,
    });

    const merged = session.getDoc('page:1') as { title: string; extra?: string };
    expect(merged.extra).toBe('change-after-first-snapshot');

    session.close();
  });

  it('B1c: acks drive attachAckCompaction to snapshot every N acked appends per doc', () => {
    const { factory, sockets } = createMockWebSocketFactory();
    const session: RoomSession = openRoomSession({
      syncUrl: 'https://sync.example.com',
      roomId: 'room1',
      auth: { kind: 'owner', ownerToken: 'ot' },
      webSocketFactory: factory,
      callbacks: { onStatus: () => undefined },
    });
    const ws = sockets[0];
    ws.open();
    ws.receive({ t: 'welcome', role: 'owner', docs: [], notebookTitle: 'x' });
    ws.receive({ t: 'synced' });

    const fullBytes = new Uint8Array([9, 9, 9]);
    const unsubscribe = attachAckCompaction(session, () => fullBytes, { everyAckedAppends: 3 });

    for (let seq = 1; seq <= 3; seq += 1) {
      ws.receive({ t: 'seq', docId: 'page:1', seq });
    }

    const snapshotFrames = ws.sentFrames().filter((frame) => frame.t === 'snapshot');
    expect(snapshotFrames).toHaveLength(1);
    expect(snapshotFrames[0]).toMatchObject({ docId: 'page:1', covers: 3 });

    unsubscribe();
    session.close();
  });

  it('D8: a malformed snapshot payload reports a non-fatal error and does not crash the session', () => {
    const { factory, sockets } = createMockWebSocketFactory();
    const errors: Array<{ code: string; detail?: string }> = [];
    const session = openRoomSession({
      syncUrl: 'https://sync.example.com',
      roomId: 'room1',
      auth: { kind: 'link', linkSecret: 'sec' },
      webSocketFactory: factory,
      callbacks: { onStatus: () => undefined, onError: (error) => errors.push(error) },
    });
    const ws = sockets[0];
    ws.open();
    ws.receive({ t: 'welcome', role: 'viewer', docs: [{ docId: 'page:1', kind: 'page' }], notebookTitle: 'x' });

    expect(() =>
      ws.receive({ t: 'snapshot', docId: 'page:1', payload: 'not-valid-automerge-bytes', covers: 0 }),
    ).not.toThrow();
    expect(errors.some((e) => e.code === 'bad-frame')).toBe(true);
    expect(session.getStatus()).not.toBe('error');

    session.close();
  });

  it('D14: caps the outgoing queue and drops the oldest frame past the cap', () => {
    const { factory, sockets } = createMockWebSocketFactory();
    const errors: Array<{ code: string; detail?: string }> = [];
    const session = openRoomSession({
      syncUrl: 'https://sync.example.com',
      roomId: 'room1',
      auth: { kind: 'owner', ownerToken: 'ot' },
      webSocketFactory: factory,
      callbacks: { onStatus: () => undefined, onError: (error) => errors.push(error) },
    });
    // Never open/sync the socket, so every send stays queued.
    for (let i = 0; i < 1001; i += 1) {
      session.sendLocalChange(`doc-${i}`, new Uint8Array([i % 256]));
    }
    expect(errors.some((e) => e.detail?.includes('dropped the oldest'))).toBe(true);

    sockets[0].open();
    sockets[0].receive({ t: 'welcome', role: 'owner', docs: [], notebookTitle: 'x' });
    sockets[0].receive({ t: 'synced' });
    const appendFrames = sockets[0].sentFrames().filter((frame) => frame.t === 'append');
    expect(appendFrames).toHaveLength(1000);
    // The very first queued send (doc-0) was dropped; doc-1 is now the oldest surviving frame.
    expect(appendFrames[0].docId).toBe('doc-1');

    session.close();
  });

  it('sends a ping heartbeat on the configured interval', () => {
    const { factory, sockets } = createMockWebSocketFactory();
    openRoomSession({
      syncUrl: 'https://sync.example.com',
      roomId: 'room1',
      auth: { kind: 'link', linkSecret: 'sec' },
      webSocketFactory: factory,
      heartbeatIntervalMs: 25_000,
      callbacks: { onStatus: () => undefined },
    });
    const ws = sockets[0];
    ws.open();
    vi.advanceTimersByTime(25_000);
    expect(ws.sentFrames().some((frame) => frame.t === 'ping')).toBe(true);
  });

  describe('PERSONAL-SYNC.md P7: resyncStrategy', () => {
    it("with the default ('queue') still replays queued appends on reconnect", () => {
      const { factory, sockets } = createMockWebSocketFactory();
      const session = openRoomSession({
        syncUrl: 'https://sync.example.com',
        roomId: 'room1',
        auth: { kind: 'personal', jwt: 'jwt-1' },
        webSocketFactory: factory,
        random: () => 0,
        callbacks: { onStatus: () => undefined },
      });
      const first = sockets[0];
      first.open();
      first.receive({ t: 'welcome', role: 'owner', docs: [], notebookTitle: '' });
      first.receive({ t: 'synced' });

      first.serverClose(1006);
      session.sendLocalChange('page:1', new Uint8Array([1, 2, 3]));
      vi.advanceTimersByTime(2000);

      const second = sockets[1];
      second.open();
      second.receive({ t: 'welcome', role: 'owner', docs: [{ docId: 'page:1', kind: 'page' }], notebookTitle: '' });
      second.receive({ t: 'synced' });

      const appendFrames = second.sentFrames().filter((frame) => frame.t === 'append');
      const snapshotFrames = second.sentFrames().filter((frame) => frame.t === 'snapshot');
      expect(appendFrames).toHaveLength(1);
      expect(snapshotFrames).toHaveLength(0);

      session.close();
    });

    it("with 'snapshot' sends one snapshot per dirty doc and zero replayed appends", () => {
      const { factory, sockets } = createMockWebSocketFactory();
      const fullBytes = new Map<string, Uint8Array>();
      const session = openRoomSession({
        syncUrl: 'https://sync.example.com',
        roomId: 'room1',
        auth: { kind: 'personal', jwt: 'jwt-1' },
        webSocketFactory: factory,
        random: () => 0,
        resyncStrategy: 'snapshot',
        getFullSnapshotBytes: (docId) => fullBytes.get(docId),
        callbacks: { onStatus: () => undefined },
      });
      const first = sockets[0];
      first.open();
      first.receive({
        t: 'welcome',
        role: 'owner',
        docs: [{ docId: 'page:1', kind: 'page' }, { docId: 'page:2', kind: 'page' }],
        notebookTitle: '',
      });
      first.receive({ t: 'synced' });

      // Disconnect, then make local edits to two docs while offline.
      first.serverClose(1006);
      fullBytes.set('page:1', new Uint8Array([1, 1, 1]));
      fullBytes.set('page:2', new Uint8Array([2, 2, 2]));
      session.sendLocalChange('page:1', new Uint8Array([9]));
      session.sendLocalChange('page:2', new Uint8Array([9]));
      session.announceDoc('page:3', 'page'); // created while offline: must be flushed before snapshots.
      vi.advanceTimersByTime(2000);

      const second = sockets[1];
      second.open();
      second.receive({
        t: 'welcome',
        role: 'owner',
        docs: [{ docId: 'page:1', kind: 'page' }, { docId: 'page:2', kind: 'page' }],
        notebookTitle: '',
      });
      second.receive({ t: 'synced' });

      const frames = second.sentFrames();
      const appendFrames = frames.filter((frame) => frame.t === 'append');
      const snapshotFrames = frames.filter((frame) => frame.t === 'snapshot');
      const announceFrames = frames.filter((frame) => frame.t === 'announce');
      expect(appendFrames).toHaveLength(0);
      expect(snapshotFrames).toHaveLength(2);
      expect(snapshotFrames.map((frame) => frame.docId).sort()).toEqual(['page:1', 'page:2']);
      expect(announceFrames.map((frame) => frame.docId)).toEqual(['page:3']);
      // announce is flushed before the snapshots.
      expect(frames.findIndex((frame) => frame.t === 'announce'))
        .toBeLessThan(frames.findIndex((frame) => frame.t === 'snapshot'));

      session.close();
    });

    it("under 'snapshot' the outgoing queue no longer loses data past the D14 cap", () => {
      const { factory, sockets } = createMockWebSocketFactory();
      const fullBytes = new Map<string, Uint8Array>();
      for (let i = 0; i < 1001; i += 1) fullBytes.set(`doc-${i}`, new Uint8Array([i % 256]));
      const errors: Array<{ code: string; detail?: string }> = [];
      const session = openRoomSession({
        syncUrl: 'https://sync.example.com',
        roomId: 'room1',
        auth: { kind: 'personal', jwt: 'jwt-1' },
        webSocketFactory: factory,
        resyncStrategy: 'snapshot',
        getFullSnapshotBytes: (docId) => fullBytes.get(docId),
        callbacks: { onStatus: () => undefined, onError: (error) => errors.push(error) },
      });
      // Never open/sync the socket: every doc is recorded dirty, none queued as a frame.
      for (let i = 0; i < 1001; i += 1) {
        session.sendLocalChange(`doc-${i}`, new Uint8Array([i % 256]));
      }
      expect(errors.some((error) => error.detail?.includes('dropped the oldest'))).toBe(false);

      sockets[0].open();
      sockets[0].receive({ t: 'welcome', role: 'owner', docs: [], notebookTitle: '' });
      sockets[0].receive({ t: 'synced' });

      const snapshotFrames = sockets[0].sentFrames().filter((frame) => frame.t === 'snapshot');
      expect(snapshotFrames).toHaveLength(1001);

      session.close();
    });

    it('surfaces a quota-exceeded error and stops syncing a doc whose snapshot exceeds SPACE_MAX_SNAPSHOT_BYTES', () => {
      const { factory, sockets } = createMockWebSocketFactory();
      const errors: Array<{ code: string; detail?: string }> = [];
      const oversized = new Uint8Array(10 * 1024 * 1024 + 1);
      const session = openRoomSession({
        syncUrl: 'https://sync.example.com',
        roomId: 'room1',
        auth: { kind: 'personal', jwt: 'jwt-1' },
        webSocketFactory: factory,
        resyncStrategy: 'snapshot',
        getFullSnapshotBytes: () => oversized,
        callbacks: { onStatus: () => undefined, onError: (error) => errors.push(error) },
      });
      session.sendLocalChange('page:huge', new Uint8Array([1]));
      sockets[0].open();
      sockets[0].receive({ t: 'welcome', role: 'owner', docs: [{ docId: 'page:huge', kind: 'page' }], notebookTitle: '' });
      sockets[0].receive({ t: 'synced' });

      expect(sockets[0].sentFrames().some((frame) => frame.t === 'snapshot')).toBe(false);
      expect(errors.some((error) => error.code === 'quota-exceeded')).toBe(true);

      session.close();
    });
  });

  describe('getAuth', () => {
    it('is called on every connect attempt, including reconnects', async () => {
      const { factory, sockets } = createMockWebSocketFactory();
      let calls = 0;
      const getAuth = vi.fn(async () => {
        calls += 1;
        return { kind: 'personal' as const, jwt: `jwt-${calls}` };
      });
      const session = openRoomSession({
        syncUrl: 'https://sync.example.com',
        roomId: 'room1',
        auth: { kind: 'personal', jwt: 'unused' },
        getAuth,
        webSocketFactory: factory,
        random: () => 0,
        callbacks: { onStatus: () => undefined },
      });
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      expect(getAuth).toHaveBeenCalledTimes(1);
      sockets[0].open();
      expect(sockets[0].sentFrames()[0]).toEqual({
        t: 'hello',
        auth: { kind: 'personal', jwt: 'jwt-1' },
        since: {},
      });

      sockets[0].serverClose(1006);
      vi.advanceTimersByTime(2000);
      await vi.waitFor(() => expect(sockets).toHaveLength(2));
      expect(getAuth).toHaveBeenCalledTimes(2);
      sockets[1].open();
      expect(sockets[1].sentFrames()[0]).toMatchObject({ auth: { kind: 'personal', jwt: 'jwt-2' } });

      session.close();
    });

    it('when absent, resolves synchronously to options.auth for every attempt (unchanged default behaviour)', () => {
      const { factory, sockets } = createMockWebSocketFactory();
      openRoomSession({
        syncUrl: 'https://sync.example.com',
        roomId: 'room1',
        auth: { kind: 'link', linkSecret: 'sec' },
        webSocketFactory: factory,
        callbacks: { onStatus: () => undefined },
      });
      // No getAuth: the socket must exist synchronously, with no awaited tick.
      expect(sockets).toHaveLength(1);
    });
  });

  describe('reauth', () => {
    it('sendReauth sends a reauth frame and subscribeReauthed fires on the server ack', () => {
      const { factory, sockets } = createMockWebSocketFactory();
      const expiries: number[] = [];
      const session = openRoomSession({
        syncUrl: 'https://sync.example.com',
        roomId: 'room1',
        auth: { kind: 'personal', jwt: 'jwt-1' },
        webSocketFactory: factory,
        callbacks: { onStatus: () => undefined },
      });
      const unsubscribe = session.subscribeReauthed((expiresAt) => expiries.push(expiresAt));
      const ws = sockets[0];
      ws.open();
      ws.receive({ t: 'welcome', role: 'owner', docs: [], notebookTitle: '' });
      ws.receive({ t: 'synced' });

      session.sendReauth('jwt-2');
      expect(ws.sentFrames().at(-1)).toEqual({ t: 'reauth', jwt: 'jwt-2' });

      ws.receive({ t: 'reauthed', expiresAt: 1_700_000_000 });
      expect(expiries).toEqual([1_700_000_000]);

      unsubscribe();
      session.close();
    });
  });
});

describe('presence over a room session', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function liveSession() {
    const { factory, sockets } = createMockWebSocketFactory();
    const errors: string[] = [];
    const session = openRoomSession({
      syncUrl: 'https://sync.example.com',
      roomId: 'room1',
      auth: { kind: 'owner', ownerToken: 'tok' },
      webSocketFactory: factory,
      callbacks: { onStatus: () => undefined, onError: (error) => errors.push(error.detail ?? error.code) },
    });
    const ws = sockets[0];
    ws.open();
    return { session, ws, sockets, errors };
  }

  it('never queues presence while not live, and sends it once live', () => {
    const { session, ws } = liveSession();
    expect(session.sendPresence({ v: 1 })).toBe(false);
    ws.receive({ t: 'welcome', role: 'owner', docs: [], notebookTitle: 'N' });
    ws.receive({ t: 'synced' });
    expect(session.sendPresence({ v: 1, page: 'p' })).toBe(true);
    const presenceFrames = ws.sentFrames().filter((frame) => frame.t === 'presence');
    expect(presenceFrames).toEqual([{ t: 'presence', state: { v: 1, page: 'p' } }]);
    session.close();
  });

  it('delivers peer states and leaves, then live and reset around a reconnect', () => {
    const { session, ws, sockets } = liveSession();
    const events: string[] = [];
    session.subscribePresence((event) => events.push(event.kind === 'state' ? `state:${event.from}:${event.role}` : event.kind));
    ws.receive({ t: 'welcome', role: 'owner', docs: [], notebookTitle: 'N' });
    ws.receive({ t: 'synced' });
    ws.receive({ t: 'presence', from: 'c1', role: 'editor', state: { v: 1 } });
    ws.receive({ t: 'presence-leave', from: 'c1' });
    ws.serverClose(1006);
    vi.advanceTimersByTime(2_000);
    const second = sockets[1];
    second.open();
    second.receive({ t: 'welcome', role: 'owner', docs: [], notebookTitle: 'N' });
    second.receive({ t: 'synced' });
    expect(events).toEqual(['live', 'state:c1:editor', 'leave', 'reset', 'live']);
    session.close();
  });

  it('stops sending presence when an older server does not know the frame type', () => {
    const { session, ws, errors } = liveSession();
    ws.receive({ t: 'welcome', role: 'owner', docs: [], notebookTitle: 'N' });
    ws.receive({ t: 'synced' });
    expect(session.sendPresence({ v: 1 })).toBe(true);
    ws.receive({ t: 'error', code: 'bad-frame', detail: 'unknown frame type' });
    expect(session.sendPresence({ v: 1 })).toBe(false);
    expect(errors).toEqual([]);
    session.close();
  });
});

describe('reconnect when the network returns', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('reconnects on the online event instead of waiting out a long backoff', () => {
    const { factory, sockets } = createMockWebSocketFactory();
    const network = new EventTarget();
    const session = openRoomSession({
      syncUrl: 'https://sync.example.com',
      roomId: 'room1',
      auth: { kind: 'owner', ownerToken: 'tok' },
      webSocketFactory: factory,
      minBackoffMs: 30_000,
      maxBackoffMs: 30_000,
      random: () => 0,
      networkEvents: network,
      callbacks: { onStatus: () => undefined },
    });
    sockets[0].serverClose(1006);
    vi.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(1);
    network.dispatchEvent(new Event('online'));
    expect(sockets).toHaveLength(2);
    session.close();
    network.dispatchEvent(new Event('online'));
    expect(sockets).toHaveLength(2);
  });
});

describe("owner mode (docStorage: 'bytes')", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function ownerSession(options: { hotDocIdleMs?: number; resyncStrategy?: 'queue' | 'snapshot' | 'reconcile' } = {}) {
    const { factory, sockets } = createMockWebSocketFactory();
    const session = openRoomSession({
      syncUrl: 'https://sync.example.com',
      roomId: 'room1',
      auth: { kind: 'owner', ownerToken: 'tok' },
      webSocketFactory: factory,
      docStorage: 'bytes',
      ...options,
      callbacks: { onStatus: () => undefined },
    });
    const ws = sockets[0];
    ws.open();
    ws.receive({
      t: 'welcome', role: 'owner', notebookTitle: 'N',
      docs: [{ docId: 'page:1', kind: 'page' }, { docId: 'page:2', kind: 'page' }],
    });
    return { session, ws };
  }

  type Page = { title: string; strokes: number[] };

  it('holds no live Automerge documents once frames are merged, only bytes and heads', () => {
    const { session, ws } = ownerSession({ hotDocIdleMs: 50 });
    let page1 = Automerge.from<Page>({ title: 'one', strokes: [] });
    const page2 = Automerge.from<Page>({ title: 'two', strokes: [] });
    ws.receive({ t: 'snapshot', docId: 'page:1', payload: encodeBase64Url(Automerge.save(page1)), covers: 0 });
    ws.receive({ t: 'snapshot', docId: 'page:2', payload: encodeBase64Url(Automerge.save(page2)), covers: 0 });
    for (let seq = 1; seq <= 3; seq += 1) {
      const before = Automerge.getHeads(page1);
      page1 = Automerge.change(page1, (draft) => { draft.strokes.push(seq); });
      ws.receive({ t: 'append', docId: 'page:1', payload: encodeBase64Url(Automerge.saveSince(page1, before)), seq });
    }
    ws.receive({ t: 'synced' });

    // At most the doc that changed last stays loaded, and only for a moment.
    expect(session.getMemoryDiagnostics().liveDocs).toBeLessThanOrEqual(1);
    vi.advanceTimersByTime(60);
    expect(session.getMemoryDiagnostics()).toMatchObject({ liveDocs: 0 });
    expect(session.getMemoryDiagnostics().storedBytes).toBeGreaterThan(0);
    expect(session.getDoc('page:1')).toBeUndefined();
    expect(session.getDocs().get('page:1')?.doc).toBeUndefined();

    // What it keeps is the merged room copy.
    const bytes = session.getDocBytes('page:1');
    expect(bytes).toBeDefined();
    const loaded = Automerge.load<Page>(bytes!);
    expect([...loaded.strokes]).toEqual([1, 2, 3]);
    expect(session.getConfirmedHeads('page:1')).toEqual(Automerge.getHeads(page1));
    expect(session.getConfirmedHeads('page:2')).toEqual(Automerge.getHeads(page2));
    expect(session.getMemoryDiagnostics().liveDocs).toBe(0);
    session.close();
  });

  it('getDocBytes includes the latest frame while the doc is still loaded', () => {
    const { session, ws } = ownerSession({ hotDocIdleMs: 10_000 });
    let page = Automerge.from<Page>({ title: 'one', strokes: [] });
    ws.receive({ t: 'snapshot', docId: 'page:1', payload: encodeBase64Url(Automerge.save(page)), covers: 0 });
    const before = Automerge.getHeads(page);
    page = Automerge.change(page, (draft) => { draft.title = 'latest'; });
    ws.receive({ t: 'append', docId: 'page:1', payload: encodeBase64Url(Automerge.saveSince(page, before)), seq: 1 });
    expect(Automerge.load<Page>(session.getDocBytes('page:1')!).title).toBe('latest');
    session.close();
  });

  it('merges a second snapshot into the stored copy instead of replacing it', () => {
    const { session, ws } = ownerSession({ hotDocIdleMs: 0 });
    const base = Automerge.from<Page & { extra?: string }>({ title: 'first', strokes: [] });
    ws.receive({ t: 'snapshot', docId: 'page:1', payload: encodeBase64Url(Automerge.save(base)), covers: 0 });
    const advanced = Automerge.change(Automerge.clone(base), (draft) => { draft.extra = 'kept'; });
    ws.receive({ t: 'append', docId: 'page:1', payload: encodeBase64Url(Automerge.saveSince(advanced, Automerge.getHeads(base))), seq: 1 });
    vi.advanceTimersByTime(1);
    const other = Automerge.from({ title: 'from elsewhere' });
    ws.receive({ t: 'snapshot', docId: 'page:1', payload: encodeBase64Url(Automerge.save(other)), covers: 0 });
    vi.advanceTimersByTime(1);
    expect(Automerge.load<Page & { extra?: string }>(session.getDocBytes('page:1')!).extra).toBe('kept');
    session.close();
  });

  function workspaceOwnerSession() {
    const { factory, sockets } = createMockWebSocketFactory();
    const session = openRoomSession({
      syncUrl: 'https://sync.example.com',
      roomId: 'room1',
      auth: { kind: 'owner', ownerToken: 'tok' },
      webSocketFactory: factory,
      docStorage: 'bytes',
      resyncStrategy: 'snapshot',
      callbacks: { onStatus: () => undefined },
    });
    const ws = sockets[0];
    ws.open();
    ws.receive({ t: 'welcome', role: 'owner', notebookTitle: 'N', docs: [{ docId: 'workspace:root', kind: 'workspace' }] });
    return { session, ws };
  }

  it('hands out a workspace document\'s appended changes once, and a full copy after a snapshot', () => {
    const { session, ws } = workspaceOwnerSession();
    let workspace = Automerge.from<{ pages: Record<string, string> }>({ pages: {} });
    ws.receive({ t: 'snapshot', docId: 'workspace:root', payload: encodeBase64Url(Automerge.save(workspace)), covers: 4 });
    expect(session.takeDocUpdates('workspace:root')).toEqual({ full: true });
    const before = Automerge.getHeads(workspace);
    const held = Automerge.load<{ pages: Record<string, string> }>(Automerge.save(workspace));
    workspace = Automerge.change(workspace, (draft) => { draft.pages.one = 'a'; });
    const changes = Automerge.saveSince(workspace, before);
    ws.receive({ t: 'append', docId: 'workspace:root', payload: encodeBase64Url(changes), seq: 5 });
    const update = session.takeDocUpdates('workspace:root');
    expect(update.full).toBe(false);
    expect(update.changes).toEqual(changes);
    // Applied on a copy that held everything before, they give the room's state without loading it again.
    const copy = Automerge.loadIncremental(held, changes);
    expect(Automerge.getMissingDeps(copy, [])).toEqual([]);
    expect(copy.pages.one).toBe('a');
    // A copy without the room's history cannot take them: its dependencies are missing.
    const unrelated = Automerge.loadIncremental(Automerge.from<{ pages: Record<string, string> }>({ pages: {} }), changes);
    expect(Automerge.getMissingDeps(unrelated, [])).not.toEqual([]);
    expect(session.getDocSeq('workspace:root')).toBe(5);
    expect(session.takeDocUpdates('workspace:root')).toEqual({ full: false });
    session.close();
  });

  it('works the heads of appended changes out only when they are asked for', () => {
    const { session, ws } = workspaceOwnerSession();
    let workspace = Automerge.from<{ pages: Record<string, string> }>({ pages: {} });
    ws.receive({ t: 'snapshot', docId: 'workspace:root', payload: encodeBase64Url(Automerge.save(workspace)), covers: 1 });
    for (let seq = 2; seq <= 4; seq += 1) {
      const before = Automerge.getHeads(workspace);
      workspace = Automerge.change(workspace, (draft) => { draft.pages[`p${seq}`] = 'x'; });
      ws.receive({ t: 'append', docId: 'workspace:root', payload: encodeBase64Url(Automerge.saveSince(workspace, before)), seq });
    }
    // Nothing in the room copy was loaded to follow them, and the resume state leaves the document out until its heads are known.
    expect(session.getMemoryDiagnostics().liveDocs).toBe(0);
    expect(session.getResumeState().docs['workspace:root']).toBeUndefined();
    expect(session.getConfirmedHeads('workspace:root')).toEqual(Automerge.getHeads(workspace));
    expect(session.getResumeState().docs['workspace:root']).toMatchObject({ seq: 4, heads: Automerge.getHeads(workspace) });
    expect(Automerge.load<{ pages: Record<string, string> }>(session.getDocBytes('workspace:root')!).pages.p4).toBe('x');
    session.close();
  });

  it('keeps a snapshot it sends without a copy as it is, and skips one that adds nothing to the copy it holds', () => {
    const { session, ws } = workspaceOwnerSession();
    ws.receive({ t: 'synced' });
    const workspace = Automerge.from<{ pages: Record<string, string> }>({ pages: { one: 'a' } });
    const bytes = Automerge.save(workspace);
    session.sendSnapshot('workspace:root', bytes, 0);
    expect(ws.sentFrames().filter((frame) => frame.t === 'snapshot')).toHaveLength(1);
    expect(session.getConfirmedHeads('workspace:root')).toEqual(Automerge.getHeads(workspace));
    expect(session.getDocBytes('workspace:root')).toEqual(bytes);
    expect(session.getMemoryDiagnostics().liveDocs).toBe(0);
    session.sendSnapshot('workspace:root', bytes, 0);
    expect(session.getMemoryDiagnostics().liveDocs).toBe(0);
    session.close();
  });

  it('replaces the room copy of a document with a rewrite that shares no history with it', () => {
    const { session, ws } = workspaceOwnerSession();
    const old = Automerge.from<{ pages: Record<string, string> }>({ pages: { one: 'a' } });
    ws.receive({ t: 'snapshot', docId: 'workspace:root', payload: encodeBase64Url(Automerge.save(old)), covers: 7 });
    ws.receive({ t: 'synced' });
    const rewritten = Automerge.from<{ pages: Record<string, string> }>({ pages: { one: 'a' } });
    session.replaceDoc('workspace:root', Automerge.save(rewritten), session.getDocSeq('workspace:root')!);
    expect(ws.sentFrames().filter((frame) => frame.t === 'snapshot')).toEqual([
      { t: 'snapshot', docId: 'workspace:root', payload: encodeBase64Url(Automerge.save(rewritten)), covers: 7 },
    ]);
    expect(session.getConfirmedHeads('workspace:root')).toEqual(Automerge.getHeads(rewritten));
    expect(Automerge.getHeads(rewritten)).not.toEqual(Automerge.getHeads(old));
    session.close();
  });

  it('folds its own acknowledged appends into the room copy', () => {
    const { session, ws } = ownerSession({ hotDocIdleMs: 0, resyncStrategy: 'snapshot' });
    const page = Automerge.from<Page>({ title: 'one', strokes: [] });
    ws.receive({ t: 'snapshot', docId: 'page:1', payload: encodeBase64Url(Automerge.save(page)), covers: 0 });
    ws.receive({ t: 'synced' });
    const local = Automerge.change(Automerge.clone(page), (draft) => { draft.title = 'own edit'; });
    session.sendLocalChange('page:1', Automerge.saveSince(local, Automerge.getHeads(page)));
    ws.receive({ t: 'seq', docId: 'page:1', seq: 1 });
    vi.advanceTimersByTime(1);
    expect(session.getConfirmedHeads('page:1')).toEqual(Automerge.getHeads(local));
    session.close();
  });

  it('flushes dirty docs with an asynchronous snapshot source one after the other', async () => {
    const { factory, sockets } = createMockWebSocketFactory();
    let reading = 0;
    let maxConcurrent = 0;
    const session = openRoomSession({
      syncUrl: 'https://sync.example.com',
      roomId: 'room1',
      auth: { kind: 'personal', jwt: 'jwt' },
      webSocketFactory: factory,
      resyncStrategy: 'snapshot',
      getFullSnapshotBytes: async (docId) => {
        reading += 1;
        maxConcurrent = Math.max(maxConcurrent, reading);
        await Promise.resolve();
        reading -= 1;
        return new TextEncoder().encode(docId);
      },
      callbacks: { onStatus: () => undefined },
    });
    for (const docId of ['page:1', 'page:2', 'page:3']) session.sendLocalChange(docId, new Uint8Array([1]));
    sockets[0].open();
    sockets[0].receive({ t: 'welcome', role: 'owner', docs: [], notebookTitle: '' });
    sockets[0].receive({ t: 'synced' });
    await vi.waitFor(() => expect(sockets[0].sentFrames().filter((frame) => frame.t === 'snapshot')).toHaveLength(3));
    expect(maxConcurrent).toBe(1);
    session.close();
  });
});

describe('resuming from an earlier visit (docStorage: bytes)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  type Page = { title: string; strokes: number[] };

  function resumedSession(heads: string[]) {
    const { factory, sockets } = createMockWebSocketFactory();
    const session = openRoomSession({
      syncUrl: 'https://sync.example.com',
      roomId: 'room1',
      auth: { kind: 'owner', ownerToken: 'tok' },
      webSocketFactory: factory,
      docStorage: 'bytes',
      resume: { docs: { 'page:1': { kind: 'page', seq: 4, heads } } },
      callbacks: { onStatus: () => undefined },
    });
    sockets[0].open();
    return { session, sockets, ws: sockets[0] };
  }

  it('asks only for what came after and follows appended changes without holding a copy', () => {
    const original = Automerge.from<Page>({ title: 'one', strokes: [] });
    let page = original;
    const { session, ws } = resumedSession(Automerge.getHeads(page));
    expect(ws.sentFrames()[0]).toMatchObject({ t: 'hello', since: { 'page:1': 4 } });
    ws.receive({ t: 'welcome', role: 'owner', notebookTitle: 'N', docs: [{ docId: 'page:1', kind: 'page' }] });
    expect(session.getConfirmedHeads('page:1')).toEqual(Automerge.getHeads(page));

    const before = Automerge.getHeads(page);
    page = Automerge.change(page, (draft) => { draft.strokes.push(1); });
    ws.receive({ t: 'append', docId: 'page:1', payload: encodeBase64Url(Automerge.saveSince(page, before)), seq: 5 });
    ws.receive({ t: 'synced' });

    expect(session.getConfirmedHeads('page:1')).toEqual(Automerge.getHeads(page));
    expect(session.getMemoryDiagnostics().liveDocs).toBe(0);
    // The chunks apply to a copy that has the resumed heads.
    const applied = Automerge.loadIncremental(Automerge.clone(original), session.getDocBytes('page:1')!);
    expect([...applied.strokes]).toEqual([1]);
    expect(session.getResumeState().docs['page:1']).toMatchObject({ seq: 5, heads: Automerge.getHeads(page) });
    session.close();
  });

  it('replaces the resumed state with a snapshot the room sends instead', () => {
    let page = Automerge.from<Page>({ title: 'one', strokes: [] });
    const { session, ws } = resumedSession(Automerge.getHeads(page));
    ws.receive({ t: 'welcome', role: 'owner', notebookTitle: 'N', docs: [{ docId: 'page:1', kind: 'page' }] });
    page = Automerge.change(page, (draft) => { draft.title = 'compacted'; });
    ws.receive({ t: 'snapshot', docId: 'page:1', payload: encodeBase64Url(Automerge.save(page)), covers: 9 });
    expect(Automerge.load<Page>(session.getDocBytes('page:1')!).title).toBe('compacted');
    expect(session.getResumeState().docs['page:1']).toMatchObject({ seq: 9 });
    session.close();
  });

  it('advances the heads on the acknowledgement of its own append', () => {
    let page = Automerge.from<Page>({ title: 'one', strokes: [] });
    const { session, ws } = resumedSession(Automerge.getHeads(page));
    ws.receive({ t: 'welcome', role: 'owner', notebookTitle: 'N', docs: [{ docId: 'page:1', kind: 'page' }] });
    ws.receive({ t: 'synced' });
    const before = Automerge.getHeads(page);
    page = Automerge.change(page, (draft) => { draft.strokes.push(7); });
    session.sendLocalChange('page:1', Automerge.saveSince(page, before));
    ws.receive({ t: 'seq', docId: 'page:1', seq: 5 });
    expect(session.getConfirmedHeads('page:1')).toEqual(Automerge.getHeads(page));
    session.close();
  });

  it('fetches a document whole on a new connection when its appended changes cannot be followed', () => {
    const page = Automerge.from<Page>({ title: 'one', strokes: [] });
    const { session, sockets, ws } = resumedSession(Automerge.getHeads(page));
    ws.receive({ t: 'welcome', role: 'owner', notebookTitle: 'N', docs: [{ docId: 'page:1', kind: 'page' }] });
    ws.receive({ t: 'append', docId: 'page:1', payload: encodeBase64Url(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])), seq: 5 });
    ws.receive({ t: 'synced' });
    vi.advanceTimersByTime(2_000);
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    expect(sockets[1].sentFrames()[0]).toMatchObject({ t: 'hello', since: {} });
    session.close();
  });

  describe('lazy pages', () => {
    function pageBytes(title: string): { bytes: Uint8Array; payload: string } {
      const doc = Automerge.from({ kind: 'page', pageId: 'p', title });
      const bytes = Automerge.save(doc);
      return { bytes, payload: encodeBase64Url(bytes) };
    }

    function lazySession() {
      const { factory, sockets } = createMockWebSocketFactory();
      const changed: string[] = [];
      const session = openRoomSession({
        syncUrl: 'https://sync.example.com',
        roomId: 'room1',
        auth: { kind: 'personal', jwt: 'jwt' },
        webSocketFactory: factory,
        docStorage: 'bytes',
        lazyPages: true,
        resyncStrategy: 'snapshot',
        getFullSnapshotBytes: () => undefined,
        callbacks: { onStatus: () => undefined, onDocsChanged: (docId) => changed.push(docId) },
      });
      const ws = sockets[0]!;
      ws.open();
      return { session, ws, changed };
    }

    const welcome = {
      t: 'welcome',
      role: 'owner',
      lazy: true,
      docs: [{ docId: 'notebook:1', kind: 'notebook' }, { docId: 'page:1', kind: 'page' }, { docId: 'page:2', kind: 'page' }],
      notebookTitle: '',
    };

    it('asks for a lazy replay and lists the pages the room did not send', () => {
      const { session, ws } = lazySession();
      expect(ws.sentFrames()[0]).toMatchObject({ t: 'hello', lazy: true });
      ws.receive(welcome);
      ws.receive({ t: 'synced' });
      expect([...session.getDocs().keys()].sort()).toEqual(['notebook:1', 'page:1', 'page:2']);
      expect(session.holdsDoc('page:1')).toBe(false);
      session.close();
    });

    it('fetches pages on request and resolves when the room says fetched', async () => {
      const { session, ws, changed } = lazySession();
      ws.receive(welcome);
      ws.receive({ t: 'synced' });
      const arrival = session.fetchDocs(['page:1', 'page:2']);
      const request = ws.sentFrames().find((frame) => frame.t === 'fetch');
      expect(request).toMatchObject({ t: 'fetch', docIds: ['page:1', 'page:2'] });
      const page = pageBytes('one');
      ws.receive({ t: 'snapshot', docId: 'page:1', payload: page.payload, covers: 3 });
      ws.receive({ t: 'fetched', id: request?.id, docIds: ['page:1', 'page:2'], known: ['page:1'] });
      await expect(arrival).resolves.toBeUndefined();
      expect(changed).toContain('page:1');
      expect(session.holdsDoc('page:1')).toBe(true);
      expect(session.getDocBytes('page:1')).toEqual(page.bytes);
      expect(session.holdsDoc('page:2')).toBe(false);
      session.close();
    });

    it('ignores frames for pages it did not ask for, and follows the ones it holds', () => {
      const { session, ws, changed } = lazySession();
      ws.receive(welcome);
      ws.receive({ t: 'synced' });
      ws.receive({ t: 'append', docId: 'page:2', payload: encodeBase64Url(new Uint8Array([1, 2, 3])), seq: 5 });
      ws.receive({ t: 'snapshot', docId: 'page:2', payload: pageBytes('two').payload, covers: 5 });
      expect(changed).toEqual([]);
      expect(session.holdsDoc('page:2')).toBe(false);
      session.close();
    });

    it('rejects a pending fetch when the connection drops, and asks again after reconnecting', async () => {
      const { session, ws } = lazySession();
      ws.receive(welcome);
      ws.receive({ t: 'synced' });
      const arrival = session.fetchDocs(['page:1']);
      ws.serverClose(1006);
      await expect(arrival).rejects.toThrow(/closed/);
      await expect(session.fetchDocs(['page:1'])).rejects.toThrow(/not live/);
      session.close();
    });

    it('fails a fetch the room never answers, and forgets that the page was asked for', async () => {
      vi.useFakeTimers();
      try {
        const { factory, sockets } = createMockWebSocketFactory();
        const session = openRoomSession({
          syncUrl: 'https://sync.example.com',
          roomId: 'room1',
          auth: { kind: 'personal', jwt: 'jwt' },
          webSocketFactory: factory,
          docStorage: 'bytes',
          lazyPages: true,
          fetchTimeoutMs: 5_000,
          callbacks: { onStatus: () => undefined },
        });
        const ws = sockets[0]!;
        ws.open();
        ws.receive(welcome);
        ws.receive({ t: 'synced' });
        const arrival = session.fetchDocs(['page:1']);
        const failure = expect(arrival).rejects.toThrow(/did not answer/);
        await vi.advanceTimersByTimeAsync(5_001);
        await failure;
        expect(session.awaitsFetch('page:1')).toBe(true);
        session.close();
      } finally {
        vi.useRealTimers();
      }
    });

    it('reports which pages the room holds without having sent or been asked for them', () => {
      const { session, ws } = lazySession();
      ws.receive(welcome);
      ws.receive({ t: 'synced' });
      expect(session.awaitsFetch('page:1')).toBe(true);
      expect(session.awaitsFetch('notebook:1')).toBe(true);
      void session.fetchDocs(['page:1']).catch(() => undefined);
      // Still unknown while the answer is on its way; known (as empty) once the room said it sent everything.
      expect(session.awaitsFetch('page:1')).toBe(true);
      const request = ws.sentFrames().find((frame) => frame.t === 'fetch');
      ws.receive({ t: 'fetched', id: request?.id, docIds: ['page:1'], known: ['page:1'] });
      expect(session.awaitsFetch('page:1')).toBe(false);
      expect(session.awaitsFetch('page:unknown')).toBe(false);
      session.close();
    });

    it('accepts an older room that replays every page unasked', () => {
      const { session, ws } = lazySession();
      ws.receive({ ...welcome, lazy: undefined });
      const page = pageBytes('unasked');
      ws.receive({ t: 'snapshot', docId: 'page:1', payload: page.payload, covers: 0 });
      ws.receive({ t: 'synced' });
      expect(session.holdsDoc('page:1')).toBe(true);
      return expect(session.fetchDocs(['page:1', 'page:2'])).resolves.toBeUndefined();
    });
  });
});
