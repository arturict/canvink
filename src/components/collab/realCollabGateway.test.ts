import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRealCollabGateway, toAuthCredential, toAuthResolver } from './realCollabGateway';
import { getOwnerRoom, removeOwnerRoom, saveOwnerRoom } from './ownerRoomStore';
import { removeJoinedRoom, saveJoinedRoom } from './joinedRoomStore';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * `ownerRoomStore.ts` reads/writes the real `localStorage`, which this
 * project's vitest config runs under Node's `environment: 'node'` — where
 * `localStorage` is `undefined` (Node's own localStorage support is
 * experimental and requires `--localstorage-file`, unset here). Stub a
 * minimal in-memory implementation so these gateway tests exercise the real
 * `ownerRoomStore` persistence path instead of silently no-op-ing.
 */
function stubLocalStorage(): void {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
  });
}

describe('toAuthResolver', () => {
  it('is absent for static credentials, so those sessions keep the synchronous connect path', () => {
    expect(toAuthResolver({ roomId: 'room1', linkSecret: 'sec1' })).toBeUndefined();
    expect(toAuthResolver({ roomId: 'room1', ownerToken: 'ot1', getClerkJwt: async () => 'jwt' })).toBeUndefined();
    expect(toAuthResolver({ roomId: 'room1', linkSecret: 'sec1', clerkJwt: 'jwt1' })).toBeUndefined();
  });

  it('asks for a fresh Clerk JWT on every connect attempt instead of reusing the captured one', async () => {
    let n = 0;
    const getClerkJwt = vi.fn(async () => `jwt${++n}`);
    const resolve = toAuthResolver({ roomId: 'room1', linkSecret: 'sec1', clerkJwt: 'jwt0', getClerkJwt });
    expect(resolve).toBeDefined();
    await expect(resolve!()).resolves.toEqual({ kind: 'user', jwt: 'jwt1', linkSecret: 'sec1' });
    await expect(resolve!()).resolves.toEqual({ kind: 'user', jwt: 'jwt2', linkSecret: 'sec1' });
    expect(getClerkJwt).toHaveBeenCalledTimes(2);
  });

  it('falls back to the link credential once the user has signed out (null JWT)', async () => {
    const resolve = toAuthResolver({ roomId: 'room1', linkSecret: 'sec1', clerkJwt: 'jwt0', getClerkJwt: async () => null });
    await expect(resolve!()).resolves.toEqual({ kind: 'link', linkSecret: 'sec1' });
  });
});

describe('toAuthCredential', () => {
  it('maps an owner token to owner auth (device-local, no Clerk/link needed)', () => {
    expect(toAuthCredential({ roomId: 'room1', ownerToken: 'ot1' })).toEqual({
      kind: 'owner',
      ownerToken: 'ot1',
    });
  });

  it('maps a post-sign-in Clerk JWT + linkSecret to user auth (the sign-in upgrade path)', () => {
    // This is exactly what a join builds after `getToken()` resolves: a
    // person who just signed in via a share link becomes an editor by
    // presenting both credentials together.
    expect(toAuthCredential({ roomId: 'room1', linkSecret: 'sec1', clerkJwt: 'jwt1' })).toEqual({
      kind: 'user',
      jwt: 'jwt1',
      linkSecret: 'sec1',
    });
  });

  it('maps a Clerk JWT alone to user auth without a linkSecret (already a registered collaborator)', () => {
    expect(toAuthCredential({ roomId: 'room1', clerkJwt: 'jwt1' })).toEqual({
      kind: 'user',
      jwt: 'jwt1',
    });
  });

  it('maps a bare linkSecret to viewer auth (the anonymous join path)', () => {
    expect(toAuthCredential({ roomId: 'room1', linkSecret: 'sec1' })).toEqual({
      kind: 'link',
      linkSecret: 'sec1',
    });
  });

  it('prefers ownerToken over any other credential present at once', () => {
    expect(toAuthCredential({ roomId: 'room1', ownerToken: 'ot1', linkSecret: 'sec1', clerkJwt: 'jwt1' }))
      .toEqual({ kind: 'owner', ownerToken: 'ot1' });
  });

  it('rejects a credential set with nothing to authenticate', () => {
    expect(() => toAuthCredential({ roomId: 'room1' })).toThrow();
  });
});

describe('sharing management / unshareNotebook', () => {
  beforeEach(() => {
    stubLocalStorage();
  });

  afterEach(() => {
    removeOwnerRoom('school');
    removeJoinedRoom('school');
    vi.unstubAllGlobals();
  });

  const sharing = (overrides: Record<string, unknown> = {}) => ({
    notebookTitle: 'Schule',
    you: { role: 'owner' },
    owner: {},
    members: [],
    invites: [],
    link: { enabled: false, linkSecret: null },
    ...overrides,
  });

  it('loads the people, invitations and link of a room with the owner token, and builds both app links', async () => {
    saveOwnerRoom('school', { roomId: 'room-1', ownerToken: 'owner-token' });
    const requests: Array<{ method: string; url: string; authorization: string | null }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        method: init?.method ?? 'GET',
        url: String(input),
        authorization: new Headers(init?.headers).get('authorization'),
      });
      return jsonResponse(sharing({ link: { enabled: true, linkSecret: 'link-secret' } }));
    });
    const gateway = createRealCollabGateway({
      syncUrl: 'https://sync.example.com',
      appOrigin: 'https://canvink.app',
      getRuntime: () => null,
      fetchImpl,
    });

    const view = await gateway.loadSharing('school');
    expect(view.roomId).toBe('room-1');
    expect(view.shareUrl).toBe('https://canvink.app/app#join=room-1.link-secret');
    expect(view.inviteUrl).toBe('https://canvink.app/app#open=room-1');
    expect(requests).toEqual([
      { method: 'GET', url: 'https://sync.example.com/api/v1/rooms/room-1/members', authorization: 'Owner owner-token' },
    ]);
  });

  it('shows no link while it is off, and switches a link without a stored secret on to mint one', async () => {
    saveOwnerRoom('school', { roomId: 'room-1', ownerToken: 'owner-token' });
    const calls: string[] = [];
    let minted = false;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(input).replace('https://sync.example.com/api/v1', '')}`);
      if (init?.method === 'PUT') {
        minted = true;
        return jsonResponse({ enabled: true, linkSecret: 'fresh' });
      }
      return jsonResponse(sharing({ link: { enabled: true, linkSecret: minted ? 'fresh' : null } }));
    });
    const gateway = createRealCollabGateway({ syncUrl: 'https://sync.example.com', appOrigin: 'https://canvink.app', getRuntime: () => null, fetchImpl });

    const view = await gateway.loadSharing('school');
    expect(view.shareUrl).toBe('https://canvink.app/app#join=room-1.fresh');
    expect(calls).toEqual(['GET /rooms/room-1/members', 'PUT /rooms/room-1/link', 'GET /rooms/room-1/members']);
  });

  it('sends invitations, role changes, removals and link changes to the room', async () => {
    saveOwnerRoom('school', { roomId: 'room-1', ownerToken: 'owner-token' });
    const calls: Array<{ call: string; body?: unknown }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        call: `${init?.method ?? 'GET'} ${String(input).replace('https://sync.example.com/api/v1', '')}`,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      return init?.method === 'DELETE' ? new Response(null, { status: 204 }) : jsonResponse({ enabled: true, linkSecret: 'x', role: 'editor' }, 200);
    });
    const gateway = createRealCollabGateway({ syncUrl: 'https://sync.example.com', getRuntime: () => null, fetchImpl });

    await gateway.invite('school', 'ben@example.com', 'editor');
    await gateway.revokeInvite('school', 'ben@example.com');
    await gateway.changeRole('school', 'user_1', 'admin');
    await gateway.removeMember('school', 'user_1');
    await gateway.setLinkEnabled('school', false);
    await gateway.regenerateLink('school');
    expect(calls).toEqual([
      { call: 'POST /rooms/room-1/invites', body: { email: 'ben@example.com', role: 'editor' } },
      { call: 'DELETE /rooms/room-1/invites/ben%40example.com' },
      { call: 'PATCH /rooms/room-1/members/user_1', body: { role: 'admin' } },
      { call: 'DELETE /rooms/room-1/members/user_1' },
      { call: 'PUT /rooms/room-1/link', body: { enabled: false } },
      { call: 'POST /rooms/room-1/link/regenerate' },
    ]);
  });

  it('manages a joined notebook with the account token (an admin), and refuses without a signed-in account', async () => {
    saveJoinedRoom('school', { roomId: 'room-2', role: 'admin' });
    const authorizations: Array<string | null> = [];
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get('authorization'));
      return jsonResponse(sharing({ you: { role: 'admin', sub: 'user_a' } }));
    });
    const signedIn = createRealCollabGateway({
      syncUrl: 'https://sync.example.com',
      getRuntime: () => null,
      fetchImpl,
      getAccountToken: async () => 'account-jwt',
    });
    await signedIn.loadSharing('school');
    expect(authorizations).toEqual(['Bearer account-jwt']);

    const signedOut = createRealCollabGateway({ syncUrl: 'https://sync.example.com', getRuntime: () => null, fetchImpl, getAccountToken: async () => null });
    await expect(signedOut.loadSharing('school')).rejects.toThrow();
    await expect(createRealCollabGateway({ syncUrl: 'https://sync.example.com', getRuntime: () => null, fetchImpl }).loadSharing('other')).rejects.toThrow();
  });

  it('knows which notebooks are shared', () => {
    saveOwnerRoom('school', { roomId: 'room-1', ownerToken: 'owner-token' });
    const gateway = createRealCollabGateway({ syncUrl: 'https://sync.example.com', getRuntime: () => null, fetchImpl: vi.fn() });
    expect(gateway.isShared('school')).toBe(true);
    expect(gateway.isShared('private')).toBe(false);
  });

  it('deletes the room, forgets the local record, and notifies onRoomRemoved', async () => {
    saveOwnerRoom('school', { roomId: 'room-1', ownerToken: 'owner-token' });
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://sync.example.com/api/v1/rooms/room-1');
      expect(init?.method).toBe('DELETE');
      return new Response(null, { status: 204 });
    });
    const onRoomRemoved = vi.fn();

    const gateway = createRealCollabGateway({
      syncUrl: 'https://sync.example.com',
      getRuntime: () => null,
      fetchImpl,
      onRoomRemoved,
    });

    await gateway.unshareNotebook('school');
    expect(getOwnerRoom('school')).toBeUndefined();
    expect(onRoomRemoved).toHaveBeenCalledWith('school');
  });

  it('is a no-op when the notebook was never shared', async () => {
    const fetchImpl = vi.fn();
    const onRoomRemoved = vi.fn();
    const gateway = createRealCollabGateway({
      syncUrl: 'https://sync.example.com',
      getRuntime: () => null,
      fetchImpl,
      onRoomRemoved,
    });
    await expect(gateway.unshareNotebook('school')).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(onRoomRemoved).not.toHaveBeenCalled();
  });
});
