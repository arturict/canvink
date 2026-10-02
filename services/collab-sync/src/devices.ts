// Desktop device login routes (PERSONAL-SYNC.md §3.7).
//
//   POST   /api/v1/device/code          Clerk JWT   -> one-time code for a PKCE challenge
//   POST   /api/v1/device/code/status   Clerk JWT   -> pending | used | expired | unknown
//   POST   /api/v1/device/token         no header   -> code+verifier or refresh token -> tokens
//   GET    /api/v1/me/devices           Clerk JWT   -> signed-in desktop devices
//   PATCH  /api/v1/me/devices/:id       Clerk JWT   -> renames the device
//   DELETE /api/v1/me/devices/:id       Clerk JWT, or that device's own access token
//
// The Durable Object of the caller's personal space stores codes and devices,
// so revoking a device can close its live sockets in the same place.
import { verifyBearerToken } from "./auth/clerk";
import {
  DEVICE_ACCESS_TTL_SECONDS,
  DEVICE_CODE_TTL_SECONDS,
  formatDeviceCode,
  formatRefreshToken,
  isValidChallenge,
  isValidVerifier,
  mintDeviceAccessToken,
  parseDeviceCode,
  parseRefreshToken,
  verifySpaceToken,
} from "./auth/device";
import { checkDeviceCodeRateLimit, checkDeviceTokenRateLimit } from "./rateLimit";
import { deriveSpaceId, roomStub } from "./space";
import type { Env } from "./types";

const DEVICE_ID_PATH = /^\/api\/v1\/me\/devices\/([A-Za-z0-9_-]{22})$/;
const MAX_BODY_BYTES = 4096;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function bearer(request: Request): string | null {
  const match = /^Bearer (.+)$/.exec(request.headers.get("Authorization") ?? "");
  return match ? (match[1] as string) : null;
}

/** Clerk (or test shim) only: a device token must never mint more devices or
 * see the device list, so a stolen device credential cannot outlive its revocation. */
async function clerkIdentity(request: Request, env: Env) {
  const token = bearer(request);
  if (!token) return null;
  try {
    return await verifyBearerToken(token, env);
  } catch {
    return null;
  }
}

function notConfigured(env: Env): Response | null {
  if (!env.PERSONAL_SPACE_SALT || !env.DEVICE_TOKEN_SECRET) {
    return json({ error: "device-login-not-configured" }, 503);
  }
  return null;
}

async function issueTokens(
  env: Env,
  spaceId: string,
  grant: { sub: string; deviceId: string; refreshSecret: string; name?: string; picture?: string },
): Promise<Response> {
  const access = await mintDeviceAccessToken(
    { sub: grant.sub, deviceId: grant.deviceId, name: grant.name, picture: grant.picture },
    env.DEVICE_TOKEN_SECRET as string,
  );
  return json({
    token_type: "Bearer",
    access_token: access.token,
    expires_in: DEVICE_ACCESS_TTL_SECONDS,
    refresh_token: formatRefreshToken(spaceId, grant.deviceId, grant.refreshSecret),
    device_id: grant.deviceId,
    user: {
      id: grant.sub,
      ...(grant.name ? { name: grant.name } : {}),
      ...(grant.picture ? { picture: grant.picture } : {}),
    },
  });
}

async function handleCode(request: Request, env: Env): Promise<Response> {
  const identity = await clerkIdentity(request, env);
  if (!identity) return json({ error: "unauthorized" }, 401);
  if (!(await checkDeviceCodeRateLimit(identity.sub))) return json({ error: "rate-limited" }, 429);
  const body = await readJson(request);
  if (!body || !isValidChallenge(body.challenge) || (body.method !== undefined && body.method !== "S256")) {
    return json({ error: "invalid-request" }, 400);
  }
  const spaceId = await deriveSpaceId(identity.sub, env.PERSONAL_SPACE_SALT as string);
  const response = await roomStub(env, spaceId).fetch("https://room.internal/device/code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sub: identity.sub,
      challenge: body.challenge,
      ...(identity.name ? { name: identity.name } : {}),
      ...(identity.picture ? { picture: identity.picture } : {}),
    }),
  });
  if (!response.ok) return response;
  const { secret } = (await response.json()) as { secret: string };
  return json({ code: formatDeviceCode(spaceId, secret), expires_in: DEVICE_CODE_TTL_SECONDS }, 201);
}

async function handleCodeStatus(request: Request, env: Env): Promise<Response> {
  const identity = await clerkIdentity(request, env);
  if (!identity) return json({ error: "unauthorized" }, 401);
  const body = await readJson(request);
  const code = parseDeviceCode(body?.code);
  if (!code) return json({ error: "invalid-request" }, 400);
  const spaceId = await deriveSpaceId(identity.sub, env.PERSONAL_SPACE_SALT as string);
  // A code from another account's space reads as unknown, never as its status.
  if (code.spaceId !== spaceId) return json({ status: "unknown" });
  return roomStub(env, spaceId).fetch("https://room.internal/device/code/status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sub: identity.sub, secret: code.secret }),
  });
}

async function handleToken(request: Request, env: Env): Promise<Response> {
  if (!(await checkDeviceTokenRateLimit(clientIp(request)))) return json({ error: "rate-limited" }, 429);
  const body = await readJson(request);
  if (!body) return json({ error: "invalid_request" }, 400);

  if (body.grant_type === "authorization_code") {
    const code = parseDeviceCode(body.code);
    if (!code || !isValidVerifier(body.code_verifier)) return json({ error: "invalid_grant" }, 400);
    const label = typeof body.device_name === "string" ? body.device_name : "";
    const response = await roomStub(env, code.spaceId).fetch("https://room.internal/device/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant: "code",
        secret: code.secret,
        verifier: body.code_verifier,
        label,
        installId: body.install_id,
        platform: body.platform,
        appVersion: body.app_version,
      }),
    });
    if (!response.ok) return json({ error: "invalid_grant" }, 400);
    return issueTokens(env, code.spaceId, await response.json());
  }

  if (body.grant_type === "refresh_token") {
    const refresh = parseRefreshToken(body.refresh_token);
    if (!refresh) return json({ error: "invalid_grant" }, 400);
    const response = await roomStub(env, refresh.spaceId).fetch("https://room.internal/device/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant: "refresh",
        deviceId: refresh.deviceId,
        secret: refresh.secret,
        appVersion: body.app_version,
      }),
    });
    if (!response.ok) return json({ error: "invalid_grant" }, 400);
    return issueTokens(env, refresh.spaceId, await response.json());
  }

  return json({ error: "unsupported_grant_type" }, 400);
}

async function handleList(request: Request, env: Env): Promise<Response> {
  const identity = await clerkIdentity(request, env);
  if (!identity) return json({ error: "unauthorized" }, 401);
  const spaceId = await deriveSpaceId(identity.sub, env.PERSONAL_SPACE_SALT as string);
  return roomStub(env, spaceId).fetch("https://room.internal/devices", { method: "GET" });
}

async function handleRename(request: Request, env: Env, deviceId: string): Promise<Response> {
  const identity = await clerkIdentity(request, env);
  if (!identity) return json({ error: "unauthorized" }, 401);
  const body = await readJson(request);
  if (!body || typeof body.label !== "string") return json({ error: "invalid-request" }, 400);
  const spaceId = await deriveSpaceId(identity.sub, env.PERSONAL_SPACE_SALT as string);
  return roomStub(env, spaceId).fetch(`https://room.internal/devices/${deviceId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: body.label }),
  });
}

async function handleRevoke(request: Request, env: Env, deviceId: string): Promise<Response> {
  const token = bearer(request);
  if (!token) return json({ error: "unauthorized" }, 401);
  let identity;
  try {
    identity = await verifySpaceToken(token, env);
  } catch {
    return json({ error: "unauthorized" }, 401);
  }
  // A device may sign itself out; only the account's Clerk session may sign
  // out other devices.
  if (identity.deviceId && identity.deviceId !== deviceId) return json({ error: "forbidden" }, 403);
  const spaceId = await deriveSpaceId(identity.sub, env.PERSONAL_SPACE_SALT as string);
  return roomStub(env, spaceId).fetch(`https://room.internal/devices/${deviceId}`, { method: "DELETE" });
}

/** Returns a response for a device-login route, or `null` when the path is not one. */
export async function handleDeviceRoute(request: Request, env: Env, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const deviceMatch = DEVICE_ID_PATH.exec(path);
  const isDeviceRoute =
    (request.method === "POST" &&
      (path === "/api/v1/device/code" || path === "/api/v1/device/code/status" || path === "/api/v1/device/token")) ||
    (request.method === "GET" && path === "/api/v1/me/devices") ||
    ((request.method === "DELETE" || request.method === "PATCH") && deviceMatch !== null);
  if (!isDeviceRoute) return null;

  const unavailable = notConfigured(env);
  if (unavailable) return unavailable;

  if (path === "/api/v1/device/code") return handleCode(request, env);
  if (path === "/api/v1/device/code/status") return handleCodeStatus(request, env);
  if (path === "/api/v1/device/token") return handleToken(request, env);
  if (path === "/api/v1/me/devices") return handleList(request, env);
  const deviceId = (deviceMatch as RegExpExecArray)[1] as string;
  return request.method === "PATCH" ? handleRename(request, env, deviceId) : handleRevoke(request, env, deviceId);
}
