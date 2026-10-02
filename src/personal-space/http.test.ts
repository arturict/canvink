import { describe, expect, it, vi } from 'vitest';
import {
  createOrGetSpace,
  deleteAsset,
  getAsset,
  getSpace,
  headAsset,
  PersonalSpaceHttpError,
  putAsset,
  type PersonalSpaceHttpConfig,
} from './http';
import type { SpaceDescriptor } from './contract';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const descriptor: SpaceDescriptor = {
  spaceId: 'space1',
  kind: 'personal',
  docCount: 137,
  logBytes: 4_823_991,
  assetCount: 42,
  assetBytes: 118_374_625,
  createdAt: '2026-09-02T10:00:00.000Z',
  quota: { logBytes: 1_073_741_824, assetBytes: 2_147_483_648, maxAssetBytes: 67_108_864 },
};

describe('personal-space HTTP client', () => {
  const config: PersonalSpaceHttpConfig = { syncUrl: 'https://sync.example.com' };

  it('createOrGetSpace POSTs with a bearer JWT and no body', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://sync.example.com/api/v1/me/space');
      expect(init?.method).toBe('POST');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer jwt-1');
      expect(init?.body).toBeUndefined();
      return jsonResponse(descriptor, 201);
    });
    const result = await createOrGetSpace({ ...config, fetchImpl }, 'jwt-1');
    expect(result).toEqual(descriptor);
  });

  it('getSpace returns null on 404', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ error: 'not-found' }), { status: 404 }));
    const result = await getSpace({ ...config, fetchImpl }, 'jwt-1');
    expect(result).toBeNull();
  });

  it('getSpace returns the descriptor on 200', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe('https://sync.example.com/api/v1/me/space');
      return jsonResponse(descriptor);
    });
    const result = await getSpace({ ...config, fetchImpl }, 'jwt-1');
    expect(result).toEqual(descriptor);
  });

  it('createOrGetSpace throws a PersonalSpaceHttpError with the server error code', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'personal-space-not-configured' }, 503));
    await expect(createOrGetSpace({ ...config, fetchImpl }, 'jwt-1')).rejects.toMatchObject({
      status: 503,
      code: 'personal-space-not-configured',
    });
  });

  it('headAsset percent-encodes the sha256: prefix and reports existence', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://sync.example.com/api/v1/me/assets/sha256%3Aabc123');
      expect(init?.method).toBe('HEAD');
      return new Response(null, { status: 200, headers: { 'content-length': '42', 'content-type': 'image/png' } });
    });
    const result = await headAsset({ ...config, fetchImpl }, 'jwt-1', 'sha256:abc123');
    expect(result).toEqual({ exists: true, size: 42, contentType: 'image/png' });
  });

  it('headAsset reports non-existence on 404 without throwing', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));
    const result = await headAsset({ ...config, fetchImpl }, 'jwt-1', 'sha256:missing');
    expect(result).toEqual({ exists: false });
  });

  it('putAsset sends content-type/content-length headers and the raw body', async () => {
    const body = new Uint8Array([1, 2, 3]);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://sync.example.com/api/v1/me/assets/sha256%3Aabc123');
      expect(init?.method).toBe('PUT');
      const headers = init?.headers as Record<string, string>;
      expect(headers['content-type']).toBe('image/png');
      expect(headers['content-length']).toBe('3');
      expect(headers.Authorization).toBe('Bearer jwt-1');
      expect(init?.body).toBe(body);
      return jsonResponse({ assetId: 'sha256:abc123', size: 3 }, 201);
    });
    const result = await putAsset({ ...config, fetchImpl }, 'jwt-1', 'sha256:abc123', body, {
      contentType: 'image/png',
      contentLength: 3,
    });
    expect(result).toEqual({ assetId: 'sha256:abc123', size: 3 });
  });

  it('putAsset surfaces a checksum-mismatch error', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'checksum-mismatch' }, 400));
    await expect(
      putAsset({ ...config, fetchImpl }, 'jwt-1', 'sha256:abc123', new Uint8Array([1]), {
        contentType: 'image/png',
        contentLength: 1,
      }),
    ).rejects.toMatchObject({ status: 400, code: 'checksum-mismatch' });
  });

  it('getAsset returns bytes and content type, and forwards a Range header', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://sync.example.com/api/v1/me/assets/sha256%3Aabc123');
      expect((init?.headers as Record<string, string>).Range).toBe('bytes=0-1');
      return new Response(new Uint8Array([9, 8, 7]), {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      });
    });
    const result = await getAsset({ ...config, fetchImpl }, 'jwt-1', 'sha256:abc123', { range: 'bytes=0-1' });
    expect(result?.bytes).toEqual(new Uint8Array([9, 8, 7]));
    expect(result?.contentType).toBe('application/pdf');
  });

  it('getAsset returns null on 404', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));
    const result = await getAsset({ ...config, fetchImpl }, 'jwt-1', 'sha256:missing');
    expect(result).toBeNull();
  });

  it('deleteAsset resolves on 204 and is idempotent', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://sync.example.com/api/v1/me/assets/sha256%3Aabc123');
      expect(init?.method).toBe('DELETE');
      return new Response(null, { status: 204 });
    });
    await expect(deleteAsset({ ...config, fetchImpl }, 'jwt-1', 'sha256:abc123')).resolves.toBeUndefined();
  });

  it('PersonalSpaceHttpError carries status and code', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'unauthorized' }, 401));
    try {
      await createOrGetSpace({ ...config, fetchImpl }, 'bad-jwt');
      expect.unreachable('expected createOrGetSpace to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(PersonalSpaceHttpError);
      expect((error as PersonalSpaceHttpError).status).toBe(401);
      expect((error as PersonalSpaceHttpError).code).toBe('unauthorized');
    }
  });
});
