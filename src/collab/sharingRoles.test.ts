import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildInviteUrl,
  changeMemberRole,
  CollabHttpError,
  fetchRoomSharing,
  inviteByEmail,
  listInvitations,
  parseOpenFragment,
  regenerateLink,
  removeMember,
  revokeInvite,
  setLinkEnabled,
  shareUrlFor,
} from './http';
import { isRole, parseServerFrame, roleCanManage, roleCanWrite } from './protocol';
import { openRoomSession } from './session';
import { createMockWebSocketFactory } from './testMocks';

describe('roles on the wire', () => {
  it('knows the four roles and what each may do', () => {
    expect(['owner', 'admin', 'editor', 'viewer'].every(isRole)).toBe(true);
    expect(isRole('guest')).toBe(false);
    expect(roleCanWrite('viewer')).toBe(false);
    expect(roleCanWrite(undefined)).toBe(false);
    expect(['owner', 'admin', 'editor'].every((role) => roleCanWrite(role as 'owner'))).toBe(true);
    expect(roleCanManage('editor')).toBe(false);
    expect(roleCanManage('admin')).toBe(true);
    expect(roleCanManage('owner')).toBe(true);
  });

  it('parses a welcome for an admin and the live role frame, and rejects a role it does not know', () => {
    expect(parseServerFrame({ t: 'welcome', role: 'admin', docs: [], notebookTitle: 'x' })).toMatchObject({ role: 'admin' });
    expect(parseServerFrame({ t: 'role', role: 'viewer' })).toEqual({ t: 'role', role: 'viewer' });
    expect(() => parseServerFrame({ t: 'role', role: 'superuser' })).toThrow();
    expect(() => parseServerFrame({ t: 'welcome', role: 'superuser', docs: [], notebookTitle: 'x' })).toThrow();
    expect(parseServerFrame({ t: 'presence', from: 'c1', role: 'admin', state: {} })).toMatchObject({ role: 'admin' });
  });
});

describe('a reader never writes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function open(role: 'viewer' | 'editor') {
    const { factory, sockets } = createMockWebSocketFactory();
    const roles: string[] = [];
    const session = openRoomSession({
      syncUrl: 'https://sync.example.com',
      roomId: 'room1',
      auth: { kind: 'user', jwt: 'jwt' },
      webSocketFactory: factory,
      callbacks: { onStatus: () => undefined, onRole: (next) => roles.push(next) },
    });
    const ws = sockets[0];
    ws.open();
    ws.receive({ t: 'welcome', role, docs: [{ docId: 'page:1', kind: 'page' }], notebookTitle: 'x' });
    ws.receive({ t: 'synced' });
    return { session, ws, roles };
  }

  const writes = (ws: ReturnType<typeof open>['ws']) =>
    ws.sentFrames().filter((frame) => ['append', 'snapshot', 'announce', 'remove'].includes(String(frame.t)));

  it('sends no append, snapshot, announce or removal while the role is viewer', () => {
    const { session, ws } = open('viewer');
    session.sendLocalChange('page:1', new Uint8Array([1, 2, 3]));
    session.sendSnapshot('page:1', new Uint8Array([1]), 0);
    session.replaceDoc('page:1', new Uint8Array([1]), 0);
    session.announceDoc('page:2', 'page');
    session.removeDoc('page:1');
    expect(writes(ws)).toEqual([]);
    session.close();
  });

  it('follows a live demotion at once and a promotion lets the next change out', () => {
    const { session, ws, roles } = open('editor');
    session.sendLocalChange('page:1', new Uint8Array([1]));
    expect(writes(ws)).toHaveLength(1);

    ws.receive({ t: 'role', role: 'viewer' });
    expect(session.getRole()).toBe('viewer');
    session.sendLocalChange('page:1', new Uint8Array([2]));
    expect(writes(ws)).toHaveLength(1);

    ws.receive({ t: 'role', role: 'admin' });
    session.sendLocalChange('page:1', new Uint8Array([3]));
    expect(writes(ws)).toHaveLength(2);
    expect(roles).toEqual(['editor', 'viewer', 'admin']);
    session.close();
  });
});

describe('sharing management requests', () => {
  const config = { syncUrl: 'https://sync.example.com', appOrigin: 'https://canvink.app' };
  const requests: Array<{ method: string; path: string; authorization: string | null; body?: unknown }> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({
      method: init?.method ?? 'GET',
      path: String(input).replace('https://sync.example.com/api/v1', ''),
      authorization: new Headers(init?.headers).get('authorization'),
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    return init?.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({ ok: true });
  });
  const http = { ...config, fetchImpl: fetchImpl as unknown as typeof fetch };
  beforeEach(() => {
    requests.length = 0;
  });

  it('addresses people by the encoded account id or address and carries the credential', async () => {
    await inviteByEmail(http, 'room-1', { kind: 'owner', ownerToken: 'ot' }, 'ben@example.com', 'editor');
    await revokeInvite(http, 'room-1', { kind: 'user', jwt: 'jwt' }, 'ben+x@example.com');
    await changeMemberRole(http, 'room-1', { kind: 'user', jwt: 'jwt' }, 'user_1', 'viewer');
    await removeMember(http, 'room-1', { kind: 'user', jwt: 'jwt' }, 'user:1');
    await setLinkEnabled(http, 'room-1', { kind: 'owner', ownerToken: 'ot' }, true);
    await regenerateLink(http, 'room-1', { kind: 'owner', ownerToken: 'ot' });
    await fetchRoomSharing(http, 'room-1', { kind: 'owner', ownerToken: 'ot' });
    expect(requests).toEqual([
      { method: 'POST', path: '/rooms/room-1/invites', authorization: 'Owner ot', body: { email: 'ben@example.com', role: 'editor' } },
      { method: 'DELETE', path: '/rooms/room-1/invites/ben%2Bx%40example.com', authorization: 'Bearer jwt' },
      { method: 'PATCH', path: '/rooms/room-1/members/user_1', authorization: 'Bearer jwt', body: { role: 'viewer' } },
      { method: 'DELETE', path: '/rooms/room-1/members/user%3A1', authorization: 'Bearer jwt' },
      { method: 'PUT', path: '/rooms/room-1/link', authorization: 'Owner ot', body: { enabled: true } },
      { method: 'POST', path: '/rooms/room-1/link/regenerate', authorization: 'Owner ot' },
      { method: 'GET', path: '/rooms/room-1/members', authorization: 'Owner ot' },
    ]);
  });

  it('turns a refusal into an error that carries the status and the code of the Worker', async () => {
    const refusing = {
      ...config,
      fetchImpl: (async () => Response.json({ error: 'already-member' }, { status: 409 })) as unknown as typeof fetch,
    };
    const error = await inviteByEmail(refusing, 'room-1', { kind: 'owner', ownerToken: 'ot' }, 'a@b.ch', 'viewer').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CollabHttpError);
    expect(error).toMatchObject({ status: 409, code: 'already-member' });
  });

  it('lists the invitations of the signed-in account', async () => {
    const listing = {
      ...config,
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer jwt');
        return Response.json({ invitations: [{ roomId: 'r1', notebookTitle: 'Physik', role: 'viewer', createdAt: 'now' }] });
      }) as unknown as typeof fetch,
    };
    await expect(listInvitations(listing, 'jwt')).resolves.toEqual([
      { roomId: 'r1', notebookTitle: 'Physik', role: 'viewer', createdAt: 'now' },
    ]);
  });

  it('builds the read link only while it is on, and an invitation link without any secret', () => {
    expect(shareUrlFor('https://canvink.app', 'r1', { enabled: true, linkSecret: 's' })).toBe('https://canvink.app/app#join=r1.s');
    expect(shareUrlFor('https://canvink.app', 'r1', { enabled: false, linkSecret: 's' })).toBeNull();
    expect(shareUrlFor('https://canvink.app', 'r1', { enabled: true, linkSecret: null })).toBeNull();
    expect(buildInviteUrl('https://canvink.app/', 'r1')).toBe('https://canvink.app/app#open=r1');
    expect(parseOpenFragment('#open=r1')).toEqual({ roomId: 'r1' });
    expect(parseOpenFragment('#open=')).toBeNull();
    expect(parseOpenFragment('#join=r1.s')).toBeNull();
  });
});
