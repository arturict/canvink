/**
 * Thin client for the personal-space HTTP API
 * (`/api/v1/me/space`, `/api/v1/me/assets/*`; PERSONAL-SYNC.md §3.5).
 * Mirrors the shape of `src/collab/http.ts`: a config object carrying the
 * Worker origin and an injectable `fetchImpl`, one function per route.
 */

import type { SpaceDescriptor } from './contract';

export interface PersonalSpaceHttpConfig {
  /** Worker origin, e.g. `https://canvink-sync.example.com`. */
  syncUrl: string;
  fetchImpl?: typeof fetch;
}

/** Raised for any non-2xx response. `code` is the `error` field of the JSON body when present. */
export class PersonalSpaceHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly detail?: string,
  ) {
    super(`personal-space HTTP ${status}: ${code}${detail ? ` (${detail})` : ''}`);
    this.name = 'PersonalSpaceHttpError';
  }
}

export interface HeadAssetResult {
  exists: boolean;
  size?: number;
  contentType?: string;
}

export interface PutAssetResult {
  assetId: string;
  size: number;
  deduplicated?: boolean;
}

export interface GetAssetResult {
  bytes: Uint8Array;
  contentType?: string;
}

export interface PutAssetOptions {
  contentType: string;
  contentLength: number;
}

export interface GetAssetOptions {
  /** Forwarded verbatim as the `Range` header, e.g. `bytes=0-1023` (PERSONAL-SYNC.md §3.5 GET). */
  range?: string;
}

function resolveFetch(config: PersonalSpaceHttpConfig): typeof fetch {
  const impl = config.fetchImpl ?? globalThis.fetch;
  if (!impl) throw new Error('No fetch implementation is available; pass config.fetchImpl.');
  return impl;
}

function apiUrl(config: PersonalSpaceHttpConfig, path: string): string {
  return `${config.syncUrl.replace(/\/+$/, '')}/api/v1${path}`;
}

function bearerHeaders(jwt: string, extra?: Record<string, string>): Record<string, string> {
  return { Authorization: `Bearer ${jwt}`, ...(extra ?? {}) };
}

/**
 * The canonical asset id form is `sha256:<64 hex>` (`src/domain/v2/types.ts:4`).
 * `encodeURIComponent` percent-encodes the `:`, matching the Worker's
 * expected `sha256%3A<hex>` path segment (PERSONAL-SYNC.md §3.5).
 */
function assetPath(assetId: string): string {
  return `/me/assets/${encodeURIComponent(assetId)}`;
}

async function readErrorCode(response: Response): Promise<{ code: string; detail?: string }> {
  try {
    const text = await response.text();
    if (!text) return { code: 'unknown-error' };
    try {
      const parsed = JSON.parse(text) as { error?: string };
      if (typeof parsed.error === 'string') return { code: parsed.error };
    } catch {
      // Not JSON — fall through to returning the raw text as detail.
    }
    return { code: 'unknown-error', detail: text };
  } catch {
    return { code: 'unknown-error' };
  }
}

async function throwForStatus(response: Response): Promise<never> {
  const { code, detail } = await readErrorCode(response);
  throw new PersonalSpaceHttpError(response.status, code, detail);
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) return throwForStatus(response);
  return (await response.json()) as T;
}

/**
 * `POST /api/v1/me/space` — idempotent: creates the personal room on the
 * first call (`201`), returns its descriptor on every subsequent call
 * (`200`). Both status codes carry the same body shape.
 */
export async function createOrGetSpace(
  config: PersonalSpaceHttpConfig,
  jwt: string,
): Promise<SpaceDescriptor> {
  const fetchImpl = resolveFetch(config);
  const response = await fetchImpl(apiUrl(config, '/me/space'), {
    method: 'POST',
    headers: bearerHeaders(jwt),
  });
  return parseJsonResponse<SpaceDescriptor>(response);
}

/**
 * `GET /api/v1/me/space` — read-only, no side effects. Returns `null` when
 * the space was never created (`404 not-found`), so callers can distinguish
 * "no space yet" from a transport/auth failure without inspecting the error.
 */
export async function getSpace(
  config: PersonalSpaceHttpConfig,
  jwt: string,
): Promise<SpaceDescriptor | null> {
  const fetchImpl = resolveFetch(config);
  const response = await fetchImpl(apiUrl(config, '/me/space'), {
    headers: bearerHeaders(jwt),
  });
  if (response.status === 404) return null;
  return parseJsonResponse<SpaceDescriptor>(response);
}

/** `HEAD /api/v1/me/assets/:assetId` — cheap existence check, used for upload dedupe. */
export async function headAsset(
  config: PersonalSpaceHttpConfig,
  jwt: string,
  assetId: string,
): Promise<HeadAssetResult> {
  const fetchImpl = resolveFetch(config);
  const response = await fetchImpl(apiUrl(config, assetPath(assetId)), {
    method: 'HEAD',
    headers: bearerHeaders(jwt),
  });
  if (response.status === 404) return { exists: false };
  if (!response.ok) return throwForStatus(response);
  const contentLength = response.headers.get('content-length');
  const contentType = response.headers.get('content-type');
  return {
    exists: true,
    ...(contentLength !== null ? { size: Number(contentLength) } : {}),
    ...(contentType !== null ? { contentType } : {}),
  };
}

/**
 * `PUT /api/v1/me/assets/:assetId` — streams raw bytes; the checksum is
 * verified server-side by R2's `sha256` put option (PERSONAL-SYNC.md §3.5),
 * so this function never hashes the body itself.
 */
export async function putAsset(
  config: PersonalSpaceHttpConfig,
  jwt: string,
  assetId: string,
  body: BodyInit,
  options: PutAssetOptions,
): Promise<PutAssetResult> {
  const fetchImpl = resolveFetch(config);
  const response = await fetchImpl(apiUrl(config, assetPath(assetId)), {
    method: 'PUT',
    headers: bearerHeaders(jwt, {
      'content-type': options.contentType,
      'content-length': String(options.contentLength),
    }),
    body,
  });
  return parseJsonResponse<PutAssetResult>(response);
}

/** `GET /api/v1/me/assets/:assetId` — returns `null` when absent (`404`). */
export async function getAsset(
  config: PersonalSpaceHttpConfig,
  jwt: string,
  assetId: string,
  options: GetAssetOptions = {},
): Promise<GetAssetResult | null> {
  const fetchImpl = resolveFetch(config);
  const response = await fetchImpl(apiUrl(config, assetPath(assetId)), {
    headers: bearerHeaders(jwt, options.range ? { Range: options.range } : undefined),
  });
  if (response.status === 404) return null;
  if (!response.ok) return throwForStatus(response);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const contentType = response.headers.get('content-type');
  return { bytes, ...(contentType !== null ? { contentType } : {}) };
}

/**
 * `DELETE /api/v1/me/assets/:assetId` — idempotent, always `204`. Only ever
 * called from the explicit "Papierkorb endgültig leeren" flow, never
 * automatically (PERSONAL-SYNC.md §3.5).
 */
export async function deleteAsset(
  config: PersonalSpaceHttpConfig,
  jwt: string,
  assetId: string,
): Promise<void> {
  const fetchImpl = resolveFetch(config);
  const response = await fetchImpl(apiUrl(config, assetPath(assetId)), {
    method: 'DELETE',
    headers: bearerHeaders(jwt),
  });
  if (!response.ok) return throwForStatus(response);
}
