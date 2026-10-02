// Desktop device credentials (PERSONAL-SYNC.md §3.7).
//
// The Canvink desktop app never loads Clerk. It signs in through the system
// browser: canvink.example.com/desktop-login (Clerk session there) asks this
// Worker for a one-time code bound to a PKCE challenge, hands the code to the
// app via `canvink://auth`, and the app exchanges code + verifier for a device
// credential: a long-lived refresh token (stored by the app) and short-lived
// access tokens. An access token is accepted by the personal-space routes as
// an identity equivalent to the Clerk `sub` it was issued for.
//
// Formats (all base64url, no padding):
//   code           `<spaceId 22>.<secret 43>`         one-time, 120 s
//   refresh token  `cvr1.<spaceId>.<deviceId 22>.<secret 43>`
//   access token   compact JWS, HS256, header.kid = "canvink-device-v1"
//
// The spaceId prefix only routes the request to the owning Durable Object;
// possession of it grants nothing (every personal route re-derives it from a
// verified identity). The secrets are stored only as SHA-256 hashes.
import { base64UrlToBytes, bytesToBase64Url, constantTimeEqual, hmacSha256Base64Url } from "../util/crypto";
import { profileFromClaims, verifyBearerToken, type AuthEnv, type VerifiedIdentity } from "./clerk";

export interface DeviceAuthEnv extends AuthEnv {
  /** HMAC key for device access tokens. Device login fails closed (503) while unset. */
  DEVICE_TOKEN_SECRET?: string;
}

/** An identity accepted on the personal-space surface. `deviceId` is set only
 * when the caller authenticated with a device access token. */
export interface SpaceIdentity extends VerifiedIdentity {
  deviceId?: string;
}

export const DEVICE_TOKEN_KID = "canvink-device-v1";
const DEVICE_TOKEN_ISSUER = "canvink-device";
/** Access-token lifetime. Revocation is still immediate for sockets and
 * routes that reach the space's Durable Object, which checks the device row. */
export const DEVICE_ACCESS_TTL_SECONDS = 10 * 60;
export const DEVICE_CODE_TTL_SECONDS = 120;

const B64URL_22 = "[A-Za-z0-9_-]{22}";
const B64URL_43 = "[A-Za-z0-9_-]{43}";
const CODE_PATTERN = new RegExp(`^(${B64URL_22})\\.(${B64URL_43})$`);
const REFRESH_PATTERN = new RegExp(`^cvr1\\.(${B64URL_22})\\.(${B64URL_22})\\.(${B64URL_43})$`);
/** RFC 7636 §4.2: S256 challenge is base64url(SHA-256(verifier)), 43 chars. */
const CHALLENGE_PATTERN = new RegExp(`^${B64URL_43}$`);
/** RFC 7636 §4.1: 43..128 unreserved characters. */
const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

export function isValidChallenge(value: unknown): value is string {
  return typeof value === "string" && CHALLENGE_PATTERN.test(value);
}

export function isValidVerifier(value: unknown): value is string {
  return typeof value === "string" && VERIFIER_PATTERN.test(value);
}

export function parseDeviceCode(value: unknown): { spaceId: string; secret: string } | null {
  if (typeof value !== "string") return null;
  const match = CODE_PATTERN.exec(value);
  return match ? { spaceId: match[1] as string, secret: match[2] as string } : null;
}

export function formatDeviceCode(spaceId: string, secret: string): string {
  return `${spaceId}.${secret}`;
}

export function parseRefreshToken(
  value: unknown,
): { spaceId: string; deviceId: string; secret: string } | null {
  if (typeof value !== "string") return null;
  const match = REFRESH_PATTERN.exec(value);
  return match
    ? { spaceId: match[1] as string, deviceId: match[2] as string, secret: match[3] as string }
    : null;
}

export function formatRefreshToken(spaceId: string, deviceId: string, secret: string): string {
  return `cvr1.${spaceId}.${deviceId}.${secret}`;
}

export async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return bytesToBase64Url(new Uint8Array(digest));
}

function jsonToBase64Url(value: unknown): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function base64UrlToJson(segment: string): unknown {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)));
}

export interface DeviceAccessClaims {
  sub: string;
  deviceId: string;
  name?: string;
  picture?: string;
}

/** Mints a device access token. The Clerk-verified name and picture captured
 * at login travel inside it, so presence keeps showing them. */
export async function mintDeviceAccessToken(
  claims: DeviceAccessClaims,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<{ token: string; exp: number }> {
  const exp = nowSeconds + DEVICE_ACCESS_TTL_SECONDS;
  const header = jsonToBase64Url({ alg: "HS256", typ: "JWT", kid: DEVICE_TOKEN_KID });
  const payload = jsonToBase64Url({
    iss: DEVICE_TOKEN_ISSUER,
    sub: claims.sub,
    did: claims.deviceId,
    iat: nowSeconds,
    exp,
    ...(claims.name ? { name: claims.name } : {}),
    ...(claims.picture ? { picture: claims.picture } : {}),
  });
  const signature = await hmacSha256Base64Url(`${header}.${payload}`, secret);
  return { token: `${header}.${payload}.${signature}`, exp };
}

/** True when the token claims to be a device access token (header kid). Cheap
 * routing only; `verifyDeviceAccessToken` does the actual verification. */
export function looksLikeDeviceAccessToken(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  try {
    const header = base64UrlToJson(parts[0] as string) as { kid?: unknown };
    return header !== null && typeof header === "object" && header.kid === DEVICE_TOKEN_KID;
  } catch {
    return false;
  }
}

export async function verifyDeviceAccessToken(token: string, env: DeviceAuthEnv): Promise<SpaceIdentity> {
  if (!env.DEVICE_TOKEN_SECRET) throw new Error("device login not configured");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed device token");
  const [headerB64, payloadB64, signature] = parts as [string, string, string];
  const header = base64UrlToJson(headerB64) as { alg?: unknown; kid?: unknown };
  if (header.alg !== "HS256" || header.kid !== DEVICE_TOKEN_KID) throw new Error("bad device token header");
  const expected = await hmacSha256Base64Url(`${headerB64}.${payloadB64}`, env.DEVICE_TOKEN_SECRET);
  if (!constantTimeEqual(signature, expected)) throw new Error("bad device token signature");
  const claims = base64UrlToJson(payloadB64) as Record<string, unknown>;
  if (claims.iss !== DEVICE_TOKEN_ISSUER) throw new Error("bad device token issuer");
  if (typeof claims.sub !== "string" || !claims.sub) throw new Error("missing sub");
  if (typeof claims.did !== "string" || !new RegExp(`^${B64URL_22}$`).test(claims.did)) {
    throw new Error("missing device id");
  }
  if (typeof claims.exp !== "number") throw new Error("missing exp");
  if (claims.exp < Math.floor(Date.now() / 1000)) throw new Error("expired");
  return { sub: claims.sub, exp: claims.exp, deviceId: claims.did, ...profileFromClaims(claims) };
}

/**
 * Personal-space credential check: a device access token or a Clerk JWT (or,
 * in tests and local dev only, the TEST_AUTH_SECRET shim). Shared-notebook
 * routes keep using `verifyBearerToken`, which never accepts device tokens.
 */
export async function verifySpaceToken(token: string, env: DeviceAuthEnv): Promise<SpaceIdentity> {
  if (looksLikeDeviceAccessToken(token)) return verifyDeviceAccessToken(token, env);
  return verifyBearerToken(token, env);
}
