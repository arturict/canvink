// Shared test helpers: room creation, WS connect/exchange, and test-shim JWT
// minting (PROTOCOL.md's `test:<sub>:<hmac>` shape).
import { SELF, env } from "cloudflare:test";
import { expect } from "vitest";

/**
 * Each call uses a fresh synthetic `CF-Connecting-IP` by default (unless the
 * caller wants to exercise the B3 rate limiter itself) so this repo's own
 * heavy test usage of `createRoom` never collides with the real per-IP
 * limit — exactly as distinct real clients wouldn't collide in production.
 */
export async function createRoom(
  notebookTitle = "Test notebook",
  opts: { clientIp?: string } = {},
) {
  const clientIp = opts.clientIp ?? crypto.randomUUID();
  const res = await SELF.fetch("https://example.com/api/v1/rooms", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": clientIp },
    body: JSON.stringify({ notebookTitle }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { roomId: string; ownerToken: string };
}

export async function createLink(roomId: string, ownerToken: string) {
  const res = await SELF.fetch(`https://example.com/api/v1/rooms/${roomId}/links`, {
    method: "POST",
    headers: { Authorization: `Owner ${ownerToken}` },
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { linkSecret: string };
}

export async function getMeta(
  roomId: string,
  opts: { linkSecret?: string; ownerToken?: string; jwt?: string },
) {
  const url = new URL(`https://example.com/api/v1/rooms/${roomId}/meta`);
  const headers: Record<string, string> = {};
  // D2: the link secret travels as a header, never a query string.
  if (opts.linkSecret) headers["X-Link-Secret"] = opts.linkSecret;
  if (opts.ownerToken) headers.Authorization = `Owner ${opts.ownerToken}`;
  if (opts.jwt) headers.Authorization = `Bearer ${opts.jwt}`;
  return SELF.fetch(url.toString(), { headers });
}

/** Mints a test-shim bearer token: `test:<sub>:<hmacSha256(sub, secret)>`. */
export async function mintTestJwt(sub: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.TEST_AUTH_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(sub));
  const mac = bytesToBase64Url(new Uint8Array(sig));
  return `test:${sub}:${mac}`;
}

/**
 * Mints a `testv2:` shim token that also carries verified e-mail addresses:
 * `testv2:<base64url(JSON {sub,emails,name})>:<base64url HMAC-SHA256 of the payload segment>`.
 */
export async function mintTestJwtWithEmails(sub: string, emails: string[], name?: string): Promise<string> {
  const payload = textToBase64Url(JSON.stringify({ sub, emails, ...(name ? { name } : {}) }));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.TEST_AUTH_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return `testv2:${payload}:${bytesToBase64Url(new Uint8Array(sig))}`;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function textToBase64Url(text: string): string {
  return bytesToBase64Url(new TextEncoder().encode(text));
}

export function base64UrlToText(b64url: string): string {
  const padded = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const binary = atob(padded + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Full descriptor returned by `POST|GET /api/v1/me/space` (PERSONAL-SYNC.md §3.5). */
export interface SpaceDescriptor {
  spaceId: string;
  kind: "personal";
  docCount: number;
  logBytes: number;
  assetCount: number;
  assetBytes: number;
  quota: { logBytes: number; assetBytes: number; maxAssetBytes: number };
  createdAt: string;
}

/** `POST /api/v1/me/space` for a test-shim `sub`. Idempotent like the real route. */
export async function createSpace(sub: string): Promise<{ res: Response; body: SpaceDescriptor | { error: string } }> {
  const jwt = await mintTestJwt(sub);
  const res = await SELF.fetch("https://example.com/api/v1/me/space", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
  });
  const body = (await res.json()) as SpaceDescriptor | { error: string };
  return { res, body };
}

/** `GET /api/v1/me/space` for a test-shim `sub`. */
export async function getSpace(sub: string): Promise<Response> {
  const jwt = await mintTestJwt(sub);
  return SELF.fetch("https://example.com/api/v1/me/space", {
    headers: { Authorization: `Bearer ${jwt}` },
  });
}

/** `HEAD|PUT|GET|DELETE /api/v1/me/assets/:assetId` for a test-shim `sub`. */
export async function assetRequest(
  sub: string,
  method: "HEAD" | "PUT" | "GET" | "DELETE",
  assetId: string,
  opts: { body?: BodyInit; contentType?: string; range?: string } = {},
): Promise<Response> {
  const jwt = await mintTestJwt(sub);
  const headers: Record<string, string> = { Authorization: `Bearer ${jwt}` };
  if (opts.contentType) headers["Content-Type"] = opts.contentType;
  if (opts.range) headers.Range = opts.range;
  return SELF.fetch(`https://example.com/api/v1/me/assets/${assetId}`, {
    method,
    headers,
    body: opts.body,
  });
}

export async function sha256HexOf(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Opens (and awaits) a WebSocket to a room via the worker's HTTP router. */
export async function connectRoomSocket(roomId: string): Promise<WebSocket> {
  const res = await SELF.fetch(`https://example.com/api/v1/rooms/${roomId}/ws`, {
    headers: { Upgrade: "websocket" },
  });
  const ws = res.webSocket;
  if (!ws) throw new Error("no websocket in response");
  ws.accept();
  return ws;
}

/** Collects JSON frames from a socket, resolving frame-by-frame via an async queue. */
export function frameQueue(ws: WebSocket): {
  next: () => Promise<Record<string, unknown>>;
  closeEvent: () => Promise<CloseEvent>;
} {
  const queue: Record<string, unknown>[] = [];
  const waiters: ((frame: Record<string, unknown>) => void)[] = [];
  let closeResolve: ((ev: CloseEvent) => void) | undefined;
  const closePromise = new Promise<CloseEvent>((resolve) => {
    closeResolve = resolve;
  });

  ws.addEventListener("message", (event: MessageEvent) => {
    const frame = JSON.parse(event.data as string) as Record<string, unknown>;
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else queue.push(frame);
  });
  ws.addEventListener("close", (event) => {
    closeResolve?.(event as CloseEvent);
  });

  return {
    next: () =>
      new Promise((resolve) => {
        const frame = queue.shift();
        if (frame) resolve(frame);
        else waiters.push(resolve);
      }),
    closeEvent: () => closePromise,
  };
}

export function send(ws: WebSocket, frame: Record<string, unknown>): void {
  ws.send(JSON.stringify(frame));
}

/** Drains frames until `predicate` matches (or `t === "synced"` if unset), returning all seen. */
export async function collectUntilSynced(
  q: ReturnType<typeof frameQueue>,
): Promise<Record<string, unknown>[]> {
  const frames: Record<string, unknown>[] = [];
  for (;;) {
    const frame = await q.next();
    frames.push(frame);
    if (frame.t === "synced") return frames;
  }
}
