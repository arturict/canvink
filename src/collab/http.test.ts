import { describe, expect, it, vi } from 'vitest';
import {
  buildShareUrl,
  createRoom,
  createShareLink,
  deleteRoom,
  fetchRoomMeta,
  parseJoinFragment,
  revokeCollaborators,
  revokeLinks,
  type CollabHttpConfig,
} from './http';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('buildShareUrl / parseJoinFragment', () => {
  it('builds a share URL with the fragment secret', () => {
    expect(buildShareUrl('https://canvink.app', 'room123', 'secretXYZ')).toBe(
      'https://canvink.app/app#join=room123.secretXYZ',
    );
  });

  it('strips a trailing slash from the app origin', () => {
    expect(buildShareUrl('https://canvink.app/', 'r', 's')).toBe(
      'https://canvink.app/app#join=r.s',
    );
  });

  it('parses a well-formed fragment', () => {
    expect(parseJoinFragment('#join=abc-123.def_456')).toEqual({
      roomId: 'abc-123',
      linkSecret: 'def_456',
    });
  });

  it('parses without the leading hash', () => {
    expect(parseJoinFragment('join=abc.def')).toEqual({ roomId: 'abc', linkSecret: 'def' });
  });

  const fuzzCases = [
    '',
    '#',
    '#join=',
    '#join=abc',
    '#join=abc.',
    '#join=.abc',
    '#join=abc.def.ghi',
    '#join=abc.def&x=1',
    '#joins=abc.def',
    '#join=abc def',
    '#join=abc./def',
    'random garbage',
  ];
  it.each(fuzzCases)('returns null for %j', (input) => {
    expect(parseJoinFragment(input)).toBeNull();
  });
});

describe('HTTP client', () => {
  const config: CollabHttpConfig = {
    syncUrl: 'https://sync.example.com',
    appOrigin: 'https://canvink.app',
  };

  it('creates a room', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://sync.example.com/api/v1/rooms');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({ notebookTitle: 'Physics' });
      return jsonResponse({ roomId: 'r1', ownerToken: 'ot1' }, 201);
    });
    const result = await createRoom({ ...config, fetchImpl }, 'Physics');
    expect(result).toEqual({ roomId: 'r1', ownerToken: 'ot1' });
  });

  it('creates a share link and builds the share URL', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://sync.example.com/api/v1/rooms/r1/links');
      expect(init?.method).toBe('POST');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Owner ot1');
      return jsonResponse({ linkSecret: 'sec1' }, 201);
    });
    const result = await createShareLink({ ...config, fetchImpl }, 'r1', 'ot1');
    expect(result).toEqual({
      linkSecret: 'sec1',
      shareUrl: 'https://canvink.app/app#join=r1.sec1',
    });
  });

  it('revokes links with owner auth', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://sync.example.com/api/v1/rooms/r1/links');
      expect(init?.method).toBe('DELETE');
      return new Response(null, { status: 204 });
    });
    await expect(revokeLinks({ ...config, fetchImpl }, 'r1', 'ot1')).resolves.toBeUndefined();
  });

  it('D2: fetches room meta with the link secret as a header, never a query string', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://sync.example.com/api/v1/rooms/r1/meta');
      expect((init?.headers as Record<string, string>)['X-Link-Secret']).toBe('sec1');
      return jsonResponse({ notebookTitle: 'Physics', role: 'viewer', docCount: 2 });
    });
    const meta = await fetchRoomMeta({ ...config, fetchImpl }, 'r1', { kind: 'link', linkSecret: 'sec1' });
    expect(meta).toEqual({ notebookTitle: 'Physics', role: 'viewer', docCount: 2 });
  });

  it('revokes collaborators with owner auth', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://sync.example.com/api/v1/rooms/r1/collaborators');
      expect(init?.method).toBe('DELETE');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Owner ot1');
      return new Response(null, { status: 204 });
    });
    await expect(revokeCollaborators({ ...config, fetchImpl }, 'r1', 'ot1')).resolves.toBeUndefined();
  });

  it('deletes a room with owner auth', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://sync.example.com/api/v1/rooms/r1');
      expect(init?.method).toBe('DELETE');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Owner ot1');
      return new Response(null, { status: 204 });
    });
    await expect(deleteRoom({ ...config, fetchImpl }, 'r1', 'ot1')).resolves.toBeUndefined();
  });

  it('fetches room meta with a bearer JWT', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer jwt-1');
      return jsonResponse({ notebookTitle: 'Physics', role: 'editor', docCount: 2 });
    });
    const meta = await fetchRoomMeta({ ...config, fetchImpl }, 'r1', { kind: 'user', jwt: 'jwt-1' });
    expect(meta.role).toBe('editor');
  });

  it('throws with status and body detail on failure', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 404 }));
    await expect(createRoom({ ...config, fetchImpl }, 'x')).rejects.toThrow(/404/);
  });
});
