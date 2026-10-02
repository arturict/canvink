import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockWebSocketFactory } from '../collab/testMocks';
import { openRoomSession } from '../collab/session';
import {
  applyDeviceNetwork,
  attachReauthTimer,
  deriveSpaceStatus,
  openPersonalSpaceSession,
  type SpaceCredential,
} from './spaceSession';

describe('deriveSpaceStatus', () => {
  it('maps a live connection to synced', () => {
    expect(
      deriveSpaceStatus({ connectionStatus: 'live', pendingDocs: 0, nowIso: '2026-09-02T10:00:00.000Z' }),
    ).toEqual({ kind: 'synced', lastSyncedAt: '2026-09-02T10:00:00.000Z' });
  });

  it('maps connecting/syncing with no pending docs to reconnecting', () => {
    expect(deriveSpaceStatus({ connectionStatus: 'connecting', pendingDocs: 0, nowIso: 'x' })).toEqual({
      kind: 'reconnecting',
    });
    expect(deriveSpaceStatus({ connectionStatus: 'syncing', pendingDocs: 0, nowIso: 'x' })).toEqual({
      kind: 'reconnecting',
    });
  });

  it('maps connecting/syncing with pending docs to offline', () => {
    expect(deriveSpaceStatus({ connectionStatus: 'connecting', pendingDocs: 3, nowIso: 'x' })).toEqual({
      kind: 'offline',
      pendingDocs: 3,
    });
  });

  it('maps closed/error connection status to error', () => {
    expect(deriveSpaceStatus({ connectionStatus: 'closed', pendingDocs: 0, nowIso: 'x' }).kind).toBe('error');
    expect(deriveSpaceStatus({ connectionStatus: 'error', pendingDocs: 0, nowIso: 'x' }).kind).toBe('error');
  });

  it('surfaces a client-reported quota-exceeded error regardless of connection status', () => {
    expect(
      deriveSpaceStatus({
        connectionStatus: 'live',
        lastError: { code: 'quota-exceeded', detail: 'log' },
        pendingDocs: 0,
        nowIso: 'x',
      }),
    ).toEqual({ kind: 'quota-exceeded', scope: 'log' });
  });

  it('surfaces an unauthorized error as a fatal error status', () => {
    expect(
      deriveSpaceStatus({
        connectionStatus: 'live',
        lastError: { code: 'unauthorized', detail: 'expired' },
        pendingDocs: 0,
        nowIso: 'x',
      }),
    ).toEqual({ kind: 'error', message: 'expired' });
  });
});

describe('applyDeviceNetwork', () => {
  it('leaves every status alone while the device is online', () => {
    for (const status of [{ kind: 'reconnecting' }, { kind: 'error', message: 'closed' }, { kind: 'synced', lastSyncedAt: 'x' }] as const) {
      expect(applyDeviceNetwork(status, true)).toBe(status);
    }
  });

  it('reads a missing network as offline, not as reconnecting', () => {
    const offline = { kind: 'offline', pendingDocs: 0 };
    expect(applyDeviceNetwork({ kind: 'reconnecting' }, false)).toEqual(offline);
    expect(applyDeviceNetwork({ kind: 'bootstrapping', phase: 'push' }, false)).toEqual(offline);
    expect(applyDeviceNetwork({ kind: 'synced', lastSyncedAt: 'x' }, false)).toEqual(offline);
    expect(applyDeviceNetwork({ kind: 'error', message: 'The personal space connection closed.' }, false)).toEqual(offline);
  });

  it('keeps the pending count and the decisions that are not about the network', () => {
    const offline = { kind: 'offline', pendingDocs: 3 } as const;
    expect(applyDeviceNetwork(offline, false)).toBe(offline);
    const signIn = { kind: 'error', message: 'Reauthentication required.' } as const;
    expect(applyDeviceNetwork(signIn, false)).toBe(signIn);
    const quota = { kind: 'quota-exceeded', scope: 'log' } as const;
    expect(applyDeviceNetwork(quota, false)).toBe(quota);
    const link = { kind: 'link-required', localHasData: true, remoteDocCount: 2 } as const;
    expect(applyDeviceNetwork(link, false)).toBe(link);
  });
});

describe('attachReauthTimer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires before the credential expires, applying the margin and the minimum delay', async () => {
    const { factory, sockets } = createMockWebSocketFactory();
    const session = openRoomSession({
      syncUrl: 'https://sync.example.com',
      roomId: 'space1',
      auth: { kind: 'personal', jwt: 'jwt-1' },
      webSocketFactory: factory,
      callbacks: { onStatus: () => undefined },
    });
    sockets[0].open();
    sockets[0].receive({ t: 'welcome', role: 'owner', docs: [], notebookTitle: '' });
    sockets[0].receive({ t: 'synced' });

    const nowS = 1_000;
    const getAuth = vi.fn(async (): Promise<SpaceCredential> => ({ jwt: 'jwt-2', expiresAt: nowS + 60 }));
    const unsubscribe = attachReauthTimer(session, {
      getAuth,
      initialExpiresAt: nowS + 60,
      marginS: 15,
      nowS: () => nowS,
    });

    // Scheduled at max(5, 60 - 15) = 45s. Confirm it has not fired early.
    vi.advanceTimersByTime(44_000);
    expect(sockets[0].sentFrames().some((frame) => frame.t === 'reauth')).toBe(false);

    vi.advanceTimersByTime(1_000);
    await vi.waitFor(() => expect(getAuth).toHaveBeenCalledTimes(1));
    expect(sockets[0].sentFrames().at(-1)).toEqual({ t: 'reauth', jwt: 'jwt-2' });

    unsubscribe();
    session.close();
  });

  it('reschedules on every reauthed ack instead of firing again at the original delay', () => {
    const { factory, sockets } = createMockWebSocketFactory();
    const session = openRoomSession({
      syncUrl: 'https://sync.example.com',
      roomId: 'space1',
      auth: { kind: 'personal', jwt: 'jwt-1' },
      webSocketFactory: factory,
      callbacks: { onStatus: () => undefined },
    });
    sockets[0].open();
    sockets[0].receive({ t: 'welcome', role: 'owner', docs: [], notebookTitle: '' });
    sockets[0].receive({ t: 'synced' });

    let nowS = 1_000;
    const getAuth = vi.fn(async (): Promise<SpaceCredential> => ({ jwt: 'jwt-2', expiresAt: nowS + 60 }));
    const unsubscribe = attachReauthTimer(session, {
      getAuth,
      initialExpiresAt: nowS + 60,
      marginS: 15,
      nowS: () => nowS,
    });

    // Server acks the (implicit) reauth with a fresh, later deadline before
    // the originally scheduled fire — the timer must reschedule off it.
    sockets[0].receive({ t: 'reauthed', expiresAt: nowS + 600 });

    nowS += 45_000 / 1000; // pretend time passed to the original fire point
    vi.advanceTimersByTime(45_000);
    expect(getAuth).not.toHaveBeenCalled();

    unsubscribe();
    session.close();
  });

  it('reauths immediately on a visibilitychange to visible', async () => {
    const { factory, sockets } = createMockWebSocketFactory();
    const session = openRoomSession({
      syncUrl: 'https://sync.example.com',
      roomId: 'space1',
      auth: { kind: 'personal', jwt: 'jwt-1' },
      webSocketFactory: factory,
      callbacks: { onStatus: () => undefined },
    });
    sockets[0].open();
    sockets[0].receive({ t: 'welcome', role: 'owner', docs: [], notebookTitle: '' });
    sockets[0].receive({ t: 'synced' });

    const getAuth = vi.fn(async (): Promise<SpaceCredential> => ({ jwt: 'jwt-visible', expiresAt: 100_000 }));
    let visibilityListener: (() => void) | undefined;
    const visibilityTarget = {
      visibilityState: 'hidden',
      addEventListener: (_type: string, listener: () => void) => {
        visibilityListener = listener;
      },
      removeEventListener: () => undefined,
    };
    const unsubscribe = attachReauthTimer(session, {
      getAuth,
      initialExpiresAt: 100_000,
      nowS: () => 0,
      visibilityTarget,
      onlineTarget: null,
    });

    visibilityTarget.visibilityState = 'hidden';
    visibilityListener?.();
    expect(getAuth).not.toHaveBeenCalled();

    visibilityTarget.visibilityState = 'visible';
    visibilityListener?.();
    await vi.waitFor(() => expect(getAuth).toHaveBeenCalledTimes(1));

    unsubscribe();
    session.close();
  });
});

describe('openPersonalSpaceSession', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('calls getAuth on every connect attempt and reports synced once live', async () => {
    const { factory, sockets } = createMockWebSocketFactory();
    const statuses: unknown[] = [];
    let calls = 0;
    const getAuth = vi.fn(async (): Promise<SpaceCredential> => {
      calls += 1;
      return { jwt: `jwt-${calls}`, expiresAt: 1_000_000 };
    });
    const facade = openPersonalSpaceSession({
      syncUrl: 'https://sync.example.com',
      spaceId: 'space1',
      getAuth,
      getFullSnapshotBytes: () => undefined,
      webSocketFactory: factory,
      onStatus: (status) => statuses.push(status),
      visibilityTarget: null,
      onlineTarget: null,
    });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    expect(getAuth).toHaveBeenCalledTimes(1);
    sockets[0].open();
    expect(sockets[0].sentFrames()[0]).toMatchObject({ auth: { kind: 'personal', jwt: 'jwt-1' } });

    sockets[0].receive({ t: 'welcome', role: 'owner', docs: [], notebookTitle: '' });
    sockets[0].receive({ t: 'synced' });
    expect(statuses.some((status) => (status as { kind: string }).kind === 'synced')).toBe(true);
    expect(facade.getStatus().kind).toBe('synced');

    facade.close();
  });
});
